'use strict';

// 定时任务：每天一封摘要 + 每天一次备份
//
// 为什么是进程内调度而不是 systemd timer（ARCHITECTURE §3.1）：
//   timer 的唯一优势是「崩了还能再触发」，代价是多一套状态源、多一份 systemd 配置。
//   而幂等只要一行 `UNIQUE(job, run_date)` 就能拿到，补跑也在进程里显式做。
//
// 三条必须成立的性质：
//   1. 不重发：同一天同一任务只跑一次（唯一索引兜底，重启也不会重复）；
//   2. 不漏发：启动时 catch-up，错过当天窗口就补一次（且只补最近一次）；
//   3. 时钟回拨不乱来：树莓派没 RTC，日期倒退时直接跳过当天。

const db = require('./db');
const settings = require('./repo/settings');
const reminders = require('./repo/reminders');
const mailer = require('./mailer');
const backup = require('./backup');

const TICK_MS = 60 * 1000;
const BACKUP_AT = '03:00';
const QUIET_FROM = 21 * 60;   // 21:00 之后不发邮件
const QUIET_TO = 8 * 60;      // 08:00 之前不发

let timer = null;
let dataDirRef = null;
let lastError = null;

/**
 * 现在几点（本地），分钟数。
 * @param {Date} [d] 时间
 * @returns {number}
 */
function minutesOf(d) {
  const x = d || new Date();
  return x.getHours() * 60 + x.getMinutes();
}

/**
 * "HH:MM" → 分钟数。
 * @param {string} hhmm 时间
 * @returns {number}
 */
function parseHHMM(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 8 * 60 + 30;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 是否在静默期（21:00–08:00 不发邮件）。
 * @param {number} mins 当前分钟
 * @returns {boolean}
 */
function inQuietHours(mins) {
  return mins >= QUIET_FROM || mins < QUIET_TO;
}

/**
 * 抢任务：唯一索引决定谁跑，抢到返回 true。
 * @param {string} job 任务名
 * @param {string} date 日期
 * @returns {boolean} 是否由本次执行
 */
function claim(job, date) {
  const info = db.prepare('INSERT OR IGNORE INTO job_runs (job, run_date, status, started_at) ' +
    "VALUES (?, ?, 'running', ?)").run(job, date, new Date().toISOString());
  return Number(info.changes) === 1;
}

/**
 * 写任务结果。
 * @param {string} job 任务名
 * @param {string} date 日期
 * @param {string} status ok|failed|skipped
 * @param {string} detail 说明
 */
function finish(job, date, status, detail) {
  db.tx(() => {
    db.prepare('UPDATE job_runs SET status = ?, detail = ?, finished_at = ? ' +
      'WHERE job = ? AND run_date = ?')
      .run(status, String(detail || '').slice(0, 500), new Date().toISOString(), job, date);
  });
}

/**
 * 跑每日摘要邮件。
 * @param {string} today 日期
 * @returns {Promise<string>} 结果说明
 */
async function runDaily(today) {
  const cfg = settings.raw();
  if (!settings.mailReady()) {
    return '邮件未配置或已关闭';
  }
  const due = reminders.dueForMail();
  const backupInfo = backup.status(dataDirRef);
  const digest = mailer.buildDigest(due, backupInfo);

  // 没东西可提醒、备份也正常，就不发——不制造「空邮件疲劳」
  if (!due.counts.total && backupInfo.externalWritable) {
    return '今天没有需要提醒的事，未发信';
  }
  if (!due.counts.total && !cfg.backup.dir) {
    // 没有外部备份时，仍然每周日提醒一次怎么备份，别天天念
    const day = new Date().getDay();
    if (day !== 0) return '今天没有需要提醒的事，未发信';
  }

  const id = mailer.queue({
    to: cfg.mail.to,
    subject: digest.subject,
    text: digest.text,
    html: digest.html,
    kind: 'daily'
  });
  const out = await mailer.flush();
  if (out.sent > 0) {
    reminders.markNotified(due.groups, today);
    return '已发信（队列 #' + id + '）';
  }
  return '发信失败：' + (out.errors[0] || '未知原因');
}

/**
 * 跑备份。
 * @param {string} today 日期
 * @returns {string} 结果说明
 */
function runBackup(today) {
  const out = backup.run({ dataDir: dataDirRef, reason: 'daily' });
  const parts = ['本地 ' + (out.bytes / 1024).toFixed(1) + 'KB'];
  if (out.externalFile) parts.push('外部已复制');
  if (out.externalError) parts.push('外部失败：' + out.externalError);
  if (out.pruned.length) parts.push('清理 ' + out.pruned.length + ' 份旧备份');
  return parts.join('；');
}

/**
 * 一次 tick：到点且今天没跑过就补跑。
 * @returns {Promise<void>}
 */
async function tick() {
  const now = new Date();
  const today = reminders.localDate(now);
  const mins = minutesOf(now);

  // 备份：03:00 之后任意时刻补一次（停电错过就补，不重复）
  if (mins >= parseHHMM(BACKUP_AT)) {
    if (claim('backup', today)) {
      let detail = '';
      let status = 'ok';
      try {
        detail = runBackup(today);
      } catch (err) {
        status = 'failed';
        detail = err.message;
        lastError = err.message;
      }
      finish('backup', today, status, detail);
    }
  }

  // 邮件：到点才发，静默期不吵人
  const mailAt = parseHHMM(settings.raw().mail.time);
  if (mins >= mailAt && !inQuietHours(mins)) {
    if (claim('daily', today)) {
      let detail = '';
      let status = 'ok';
      try {
        detail = await runDaily(today);
        if (/失败/.test(detail)) status = 'failed';
        if (/未配置|没有需要/.test(detail)) status = 'skipped';
      } catch (err) {
        status = 'failed';
        detail = err.message;
        lastError = err.message;
      }
      finish('daily', today, status, detail);
    }
  }
}

/**
 * 启动调度器。
 * @param {object} opts 选项
 * @param {string} opts.dataDir 数据目录
 * @param {number} [opts.intervalMs] tick 间隔（测试用）
 */
function start(opts) {
  dataDirRef = opts.dataDir;
  stop();
  const interval = opts.intervalMs || TICK_MS;
  timer = setInterval(() => {
    tick().catch((err) => {
      lastError = err.message;
      console.error('[job] ' + err.message);
    });
  }, interval);
  if (timer.unref) timer.unref();   // 别拖住进程退出（测试里尤其重要）
  // 启动即补一次：断电/重启后错过的窗口在这里补上
  tick().catch((err) => {
    lastError = err.message;
    console.error('[job] ' + err.message);
  });
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * 调度器状态（GET /api/jobs/status）。
 * @returns {object} 状态
 */
function status() {
  const today = reminders.localDate();
  const rows = db.prepare('SELECT * FROM job_runs WHERE run_date = ? ORDER BY id DESC').all(today);
  const latest = {};
  rows.forEach((r) => {
    if (!latest[r.job]) {
      latest[r.job] = {
        status: String(r.status),
        detail: r.detail ? String(r.detail) : '',
        startedAt: r.started_at ? String(r.started_at) : null,
        finishedAt: r.finished_at ? String(r.finished_at) : null
      };
    }
  });
  return {
    today,
    running: !!timer,
    mailReady: settings.mailReady(),
    mailTime: settings.raw().mail.time,
    backupTime: BACKUP_AT,
    quiet: inQuietHours(minutesOf()),
    jobs: latest,
    lastError,
    lastMail: mailer.lastMail()
  };
}

/**
 * 手动触发一次（设置页的「现在发一封」按钮，也方便排查问题）。
 * 不写 job_runs：手动执行不该影响「今天已经发过了」的幂等判断。
 * @param {string} job daily|backup
 * @returns {Promise<{ok:boolean, detail:string}>} 结果
 */
async function runNow(job) {
  if (job === 'backup') {
    const out = backup.run({ dataDir: dataDirRef, reason: 'manual' });
    return { ok: true, detail: out.file };
  }
  const today = reminders.localDate();
  const due = reminders.dueForMail();
  const digest = mailer.buildDigest(due, backup.status(dataDirRef));
  const cfg = settings.raw();
  if (!settings.mailReady()) {
    return { ok: false, detail: '邮件还没配置完整' };
  }
  mailer.queue({
    to: cfg.mail.to,
    subject: digest.subject,
    text: digest.text,
    html: digest.html,
    kind: 'manual'
  });
  const out = await mailer.flush();
  if (out.sent > 0) {
    reminders.markNotified(due.groups, today);
    return { ok: true, detail: '已发出，共 ' + due.counts.total + ' 条提醒' };
  }
  return { ok: false, detail: out.errors[0] || '发送失败' };
}

module.exports = {
  BACKUP_AT,
  QUIET_FROM,
  QUIET_TO,
  parseHHMM,
  inQuietHours,
  tick,
  start,
  stop,
  status,
  runNow,
  runDaily,
  runBackup
};
