'use strict';

// 备份：本地一份（L0），有外部目录再复制一份（L1），都没有就交给邮件提醒（L2）
//
// 权限边界（DECISIONS D3）：**应用绝不执行 mount、不存 SMB 密码**。
// NAS 挂载是系统的事（/etc/fstab 或 systemd mount unit），应用只负责往「已挂载且可写」的目录里写。
// 这样一个家庭收纳服务不需要任何 root 能力，也就不会变成提权入口。

const fs = require('fs');
const path = require('path');

const db = require('./db');
const locations = require('./repo/locations');
const items = require('./repo/items');
const settings = require('./repo/settings');

const NAME_RE = /^homebox-\d{8}-\d{6}\.json$/;

/**
 * 组装导出文档（与 scripts/export.js 同形，便于回灌）。
 * @returns {object} 导出内容
 */
function buildDocument() {
  const ls = locations.loadSettings();
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: {
      planWidthM: ls.planWidthM,
      base_currency: db.getSetting('base_currency', 'CNY')
    },
    locations: locations.list(),
    items: items.listRows().map(items.rowToItem)
  };
}

/**
 * 时间戳文件名：homebox-20261022-233000.json
 * @param {Date} [d] 时间
 * @returns {string}
 */
function stamp(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return 'homebox-' + x.getFullYear() + p(x.getMonth() + 1) + p(x.getDate()) +
    '-' + p(x.getHours()) + p(x.getMinutes()) + p(x.getSeconds()) + '.json';
}

/**
 * 目录是否可写（真正写一个探针文件再删掉）。
 * @param {string} dir 目录
 * @returns {{ok:boolean, message:string}}
 */
function probeDir(dir) {
  if (!dir) return { ok: false, message: '没有配置备份位置' };
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return { ok: false, message: '这个路径不是目录' };
  } catch (err) {
    return { ok: false, message: '目录不存在或没权限访问：' + dir };
  }
  const probe = path.join(dir, '.hb-write-test-' + process.pid);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true, message: '可写' };
  } catch (err) {
    return { ok: false, message: '目录不可写（权限或只读挂载）：' + err.message };
  }
}

/**
 * 按保留份数清理旧备份。
 * @param {string} dir 目录
 * @param {number} keep 保留份数
 * @returns {string[]} 被删掉的文件名
 */
function prune(dir, keep) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => NAME_RE.test(n));
  } catch (err) {
    return [];
  }
  names.sort().reverse();                 // 文件名带时间戳，倒序就是最新在前
  const doomed = names.slice(Math.max(0, keep));
  doomed.forEach((n) => {
    try { fs.unlinkSync(path.join(dir, n)); } catch (err) { /* 删不掉就算了 */ }
  });
  return doomed;
}

/**
 * 跑一次备份。
 * @param {object} opts 选项
 * @param {string} opts.dataDir 数据目录（本地备份写这里）
 * @param {string} [opts.reason] 触发原因（日志用）
 * @returns {{ok:boolean, file:string, bytes:number, externalFile:string|null, externalError:string|null, pruned:string[]}}
 */
function run(opts) {
  const cfg = settings.raw();
  const backupDir = path.join(opts.dataDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true });

  const doc = buildDocument();
  const text = JSON.stringify(doc, null, 2);
  const name = stamp();
  const file = path.join(backupDir, name);
  // 先写临时文件再改名：和数据库写入同一个思路，避免断电留半截备份
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);

  const pruned = prune(backupDir, cfg.backup.keepLocal);

  let externalFile = null;
  let externalError = null;
  if (cfg.backup.dir) {
    const probe = probeDir(cfg.backup.dir);
    if (!probe.ok) {
      externalError = probe.message;
    } else {
      try {
        externalFile = path.join(cfg.backup.dir, name);
        fs.writeFileSync(externalFile, text, 'utf8');
        prune(cfg.backup.dir, cfg.backup.keepExternal);
      } catch (err) {
        externalError = '写外部目录失败：' + err.message;
        externalFile = null;
      }
    }
  }

  return {
    ok: true,
    reason: opts.reason || 'manual',
    file,
    bytes: Buffer.byteLength(text),
    externalFile,
    externalError,
    pruned
  };
}

/**
 * 备份状态（设置页与邮件脚注要用）。
 * @param {string} dataDir 数据目录
 * @returns {object} 状态
 */
function status(dataDir) {
  const cfg = settings.raw();
  const backupDir = path.join(dataDir, 'backup');
  let names = [];
  try {
    names = fs.readdirSync(backupDir).filter((n) => NAME_RE.test(n)).sort().reverse();
  } catch (err) {
    names = [];
  }
  const latest = names.length ? path.join(backupDir, names[0]) : null;
  let bytes = 0;
  if (latest) {
    try { bytes = fs.statSync(latest).size; } catch (err) { bytes = 0; }
  }
  const external = cfg.backup.dir ? probeDir(cfg.backup.dir) : { ok: false, message: '没配置（只备份在本机）' };
  return {
    dir: backupDir,
    count: names.length,
    keepLocal: cfg.backup.keepLocal,
    latest: latest,
    latestAt: latest ? fs.statSync(latest).mtime.toISOString() : null,
    bytes,
    externalDir: cfg.backup.dir || null,
    externalWritable: external.ok,
    externalMessage: external.message,
    keepExternal: cfg.backup.keepExternal
  };
}

module.exports = {
  buildDocument,
  probeDir,
  prune,
  run,
  status
};
