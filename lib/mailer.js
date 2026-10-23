'use strict';

// 邮件：组装每日摘要 + 发送队列
//
// 两条必须守住的纪律：
//   1. **发送永不阻塞 HTTP 请求**。任何写接口都不会等 SMTP，邮件只往 mail_outbox 里排一行；
//   2. 失败可重试但不骚扰：最多 3 次，仍失败就在站内提醒页顶部显示红字，不再反复重发。

const db = require('./db');
const smtp = require('./smtp');
const settings = require('./repo/settings');
const reminders = require('./repo/reminders');

const MAX_ATTEMPTS = 3;

/**
 * HTML 转义（邮件正文里的中文与标点要能正常显示，但用户内容必须转义）。
 * @param {*} s 内容
 * @returns {string}
 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * 标题里的日期：10月22日
 * @param {string} iso YYYY-MM-DD
 * @returns {string}
 */
function cnDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return Number(m[2]) + '月' + Number(m[3]) + '日';
}

const KIND_LABEL = {
  expire: '快过期了',
  lowStock: '快用完了',
  lent: '借出去还没还',
  idle: '很久没动过'
};

/**
 * 一条提醒的人话描述。
 * @param {object} e 提醒条目
 * @returns {string}
 */
function describe(e) {
  if (e.kind === 'expire') {
    if (e.daysLeft < 0) return '已经过期 ' + Math.abs(e.daysLeft) + ' 天（' + e.expireAt + '）';
    if (e.daysLeft === 0) return '今天到期（' + e.expireAt + '）';
    return '还有 ' + e.daysLeft + ' 天到期（' + e.expireAt + '）';
  }
  if (e.kind === 'lowStock') return '只剩 ' + e.qty + ' 个，低于你设的 ' + e.minQty;
  if (e.kind === 'lent') return '借给' + (e.lendTo || '别人') + ' ' + e.daysLent + ' 天了';
  if (e.kind === 'idle') return '已经 ' + e.idleDays + ' 天没动过';
  return '';
}

/**
 * 组装每日摘要。
 * @param {object} due reminders.dueForMail() 的结果
 * @param {object} backupInfo 备份状态（可为 null）
 * @returns {{subject:string, text:string, html:string}} 邮件内容
 */
function buildDigest(due, backupInfo) {
  const total = due.counts.total;
  const subject = total
    ? '家里有 ' + total + ' 件东西要留意（' + cnDate(due.today) + '）'
    : '家里一切正常（' + cnDate(due.today) + '）';

  const textLines = [];
  const htmlBlocks = [];

  if (total) {
    Object.keys(KIND_LABEL).forEach((kind) => {
      const list = due.groups[kind] || [];
      if (!list.length) return;
      textLines.push('');
      textLines.push('【' + KIND_LABEL[kind] + '】');
      list.forEach((e) => {
        textLines.push('  · ' + e.name + '（' + e.path + '）— ' + describe(e));
      });

      htmlBlocks.push(
        '<h3 style="margin:16px 0 6px;font-size:15px;color:#3c2f22">' +
        esc(KIND_LABEL[kind]) + '（' + list.length + '）</h3>' +
        '<ul style="margin:0;padding-left:18px;color:#4a3d30;line-height:1.7">' +
        list.map((e) => '<li><b>' + esc(e.name) + '</b> · ' + esc(e.path) +
          '<br><span style="color:#8a7a66;font-size:13px">' + esc(describe(e)) + '</span></li>').join('') +
        '</ul>'
      );
    });
  } else {
    textLines.push('今天没有需要处理的东西。');
  }

  // 备份：没外部备份就把「怎么备」写进邮件里（DECISIONS D3 的 L2）
  const backupLines = [];
  if (backupInfo) {
    if (backupInfo.externalDir && !backupInfo.externalWritable) {
      backupLines.push('外部备份目录当前不可用：' + backupInfo.externalMessage);
    }
    backupLines.push('本地备份：' + backupInfo.count + ' 份，最近一次 ' +
      (backupInfo.latestAt ? backupInfo.latestAt.slice(0, 16).replace('T', ' ') : '还没有'));

    if (!backupInfo.externalDir) {
      backupLines.push('');
      backupLines.push('你还没有配置外部备份。TF 卡坏掉就全丢了，建议花十分钟做一次：');
      backupLines.push('  1. 在 NAS / 路由器上开一个共享文件夹，记下地址与账号；');
      backupLines.push('  2. 在香橙派上建 /etc/nas.cred（两行 username= 和 password=，chmod 600），');
      backupLines.push('     并在 /etc/fstab 加一行：');
      backupLines.push('     //192.168.1.100/home /mnt/nas cifs credentials=/etc/nas.cred,uid=1000,iocharset=utf8,vers=3.0,nofail 0 0');
      backupLines.push('     然后 sudo mount -a；');
      backupLines.push('  3. 打开 HomeBox 设置页，把备份位置填成 /mnt/nas，点「检测可写」。');
      backupLines.push('');
      backupLines.push('没有 NAS 也行：把 data/backup/ 里最新的 json 拷到电脑或 U 盘，一周一次就够。');
    }
  }

  const text = [
    'HomeBox 每日摘要 · ' + cnDate(due.today),
    '─'.repeat(28)
  ].concat(textLines).concat(
    backupInfo ? ['', '【备份】'].concat(backupLines) : []
  ).concat([
    '',
    '—',
    '这封邮件由你家那台机器上的 HomeBox 定时发出。',
    '不想收：打开应用 → 设置 → 关闭邮件提醒。'
  ]).join('\n');

  const html = '<div style="font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',sans-serif;' +
    'max-width:560px;margin:0 auto;padding:24px;background:#f7f4ee;border-radius:12px;color:#3c2f22">' +
    '<h2 style="margin:0 0 4px;font-size:18px">家里的东西 · ' + esc(cnDate(due.today)) + '</h2>' +
    '<p style="margin:0 0 12px;color:#8a7a66;font-size:13px">' +
    (total ? '有 ' + total + ' 件需要留意' : '今天没有需要处理的') + '</p>' +
    htmlBlocks.join('') +
    (backupInfo
      ? '<div style="margin-top:22px;padding-top:14px;border-top:1px solid #e5dccd;' +
        'color:#8a7a66;font-size:12px;line-height:1.7">' +
        esc(backupLines.join('\n')).replace(/\n/g, '<br>') + '</div>'
      : '') +
    '<p style="margin:18px 0 0;color:#b3a795;font-size:11px">' +
    '由你家里的 HomeBox 定时发出。不想收：应用里 → 设置 → 关闭邮件提醒。</p>' +
    '</div>';

  return { subject, text, html };
}

/**
 * 把一封邮件排进队列（不发送，立刻返回）。
 * @param {object} msg 邮件
 * @returns {number} 队列 id
 */
function queue(msg) {
  const info = db.prepare('INSERT INTO mail_outbox ' +
    '(to_addr, subject, body_text, body_html, kind, status, attempts, created_at) ' +
    "VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)")
    .run(msg.to, msg.subject, msg.text, msg.html || '', msg.kind || 'daily',
      new Date().toISOString());
  return Number(info.lastInsertRowid);
}

/**
 * 发一封（同步，用于「发测试邮件」按钮，能立刻把 SMTP 原始错误回给用户）。
 * @param {object} msg 邮件内容
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function sendNow(msg) {
  const cfg = settings.raw().mail;
  if (!cfg.host || !cfg.user || !cfg.pass || !cfg.to) {
    return { ok: false, error: '邮件还没配置完整（服务器 / 账号 / 授权码 / 收件人）' };
  }
  try {
    await smtp.send({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      user: cfg.user,
      pass: cfg.pass
    }, {
      from: cfg.from || cfg.user,
      to: msg.to || cfg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 处理队列：把 pending 的按顺序发掉，失败记错误并累计次数。
 * @returns {Promise<{sent:number, failed:number, errors:string[]}>}
 */
async function flush() {
  const cfg = settings.raw().mail;
  if (!cfg.host || !cfg.user || !cfg.pass) {
    return { sent: 0, failed: 0, errors: ['邮件未配置'] };
  }
  const rows = db.prepare("SELECT * FROM mail_outbox WHERE status = 'pending' " +
    'AND attempts < ? ORDER BY id ASC LIMIT 5').all(MAX_ATTEMPTS);

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const row of rows) {
    try {
      await smtp.send({
        host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass
      }, {
        from: cfg.from || cfg.user,
        to: row.to_addr,
        subject: row.subject,
        text: row.body_text,
        html: row.body_html
      });
      db.tx(() => {
        db.prepare("UPDATE mail_outbox SET status = 'sent', attempts = attempts + 1, " +
          'sent_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      errors.push(err.message);
      db.tx(() => {
        db.prepare('UPDATE mail_outbox SET attempts = attempts + 1, last_error = ?, ' +
          "status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?")
          .run(String(err.message).slice(0, 500), MAX_ATTEMPTS, row.id);
      });
    }
  }
  return { sent, failed, errors };
}

/**
 * 最近一次邮件的状态（设置页显示）。
 * @returns {object|null}
 */
function lastMail() {
  const row = db.prepare('SELECT * FROM mail_outbox ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  return {
    id: Number(row.id),
    subject: String(row.subject),
    status: String(row.status),
    attempts: Number(row.attempts),
    lastError: row.last_error ? String(row.last_error) : null,
    sentAt: row.sent_at ? String(row.sent_at) : null,
    createdAt: String(row.created_at)
  };
}

module.exports = {
  MAX_ATTEMPTS,
  KIND_LABEL,
  buildDigest,
  describe,
  queue,
  sendNow,
  flush,
  lastMail
};
