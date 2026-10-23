'use strict';

// 通知 / 备份的配置读写
//
// 一句话原则：**密码永远不出服务端**。
// 读接口只回「配没配」（hasPass），写接口收到空字符串表示「不改密码」，
// 传 "__CLEAR__" 才表示主动清空。这样前端不用为了改个收件人重新输一遍授权码。

const db = require('../db');

const KEY = 'notify';

// 默认值即 QQ 邮箱预设（用户指定的发信方式），但 host/port 都可改，
// 将来换 163 或自建 SMTP 只改配置，不动代码。
const DEFAULTS = {
  mail: {
    enabled: false,
    host: 'smtp.qq.com',
    port: 465,
    secure: true,          // 465 = 隐式 TLS；587 = STARTTLS
    user: '',              // 完整邮箱地址，例如 xxx@qq.com
    pass: '',              // QQ 邮箱的「授权码」，不是登录密码
    from: '',              // 必须等于 user，否则 SPF 不过、直接进垃圾箱
    to: '',                // 收件人，可以用逗号分隔多个
    time: '08:30'          // 每天什么时候发（本地时间）
  },
  kinds: {
    expire: true,          // 快过期
    lowStock: true,        // 低于最低库存
    lent: true,            // 借出未还
    idle: false            // 闲置太久（默认关，避免一上来就轰炸）
  },
  expireDays: 7,           // 提前几天开始提醒
  idleDays: 365,           // 多久没动算闲置
  backup: {
    dir: '',               // 外部备份目录（NAS 挂载点），空 = 不做外部备份
    keepLocal: 7,          // 本地留几份
    keepExternal: 30       // 外部目录留几份
  }
};

/**
 * 深合并：只覆盖已知字段，防止前端塞进奇怪的东西。
 * @param {object} base 默认值
 * @param {object} patch 入参
 * @returns {object} 新对象
 */
function merge(base, patch) {
  const out = {};
  Object.keys(base).forEach((k) => {
    const b = base[k];
    const p = patch ? patch[k] : undefined;
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = merge(b, p && typeof p === 'object' ? p : {});
    } else if (p === undefined) {
      out[k] = b;
    } else {
      out[k] = p;
    }
  });
  return out;
}

/**
 * 读原始配置（含明文密码，只在服务端内部使用）。
 * @returns {object} 配置
 */
function raw() {
  const text = db.getSetting(KEY, null);
  if (!text) return merge(DEFAULTS, {});
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return merge(DEFAULTS, {});
  }
  return merge(DEFAULTS, parsed && typeof parsed === 'object' ? parsed : {});
}

/**
 * 对外安全的配置：把密码换成 hasPass。
 * @returns {object} 可返回给前端的配置
 */
function publicView() {
  const cfg = raw();
  const out = merge(DEFAULTS, cfg);
  out.mail.hasPass = !!cfg.mail.pass;
  delete out.mail.pass;
  out.mail.preset = cfg.mail.host === 'smtp.qq.com' ? 'qq'
    : (cfg.mail.host === 'smtp.163.com' ? '163' : 'custom');
  return out;
}

/**
 * 校验并保存配置。
 * @param {object} patch 前端入参
 * @returns {{error?:{status:number,error:string}, settings?:object}} 结果
 */
function save(patch) {
  const cur = raw();
  const next = merge(cur, patch || {});

  // 密码三态：没传 / 传空串 = 不改；传 "__CLEAR__" = 清空；其它 = 新密码
  const incoming = patch && patch.mail ? patch.mail.pass : undefined;
  if (incoming === undefined || incoming === '') {
    next.mail.pass = cur.mail.pass;
  } else if (incoming === '__CLEAR__') {
    next.mail.pass = '';
  } else {
    next.mail.pass = String(incoming).trim();
  }

  // 端口决定加密方式，避免「465 配了 STARTTLS」这种必然失败的组合
  next.mail.port = Number(next.mail.port) || 465;
  next.mail.secure = next.mail.port === 465;

  next.mail.user = String(next.mail.user || '').trim();
  next.mail.from = String(next.mail.from || '').trim() || next.mail.user;
  next.mail.to = String(next.mail.to || '').trim();
  next.mail.host = String(next.mail.host || '').trim();

  if (!/^\d{1,2}:\d{2}$/.test(String(next.mail.time || ''))) {
    return { error: { status: 400, error: '发送时间要写成 HH:MM，比如 08:30' } };
  }
  next.mail.time = String(next.mail.time);

  next.expireDays = Math.min(60, Math.max(0, Number(next.expireDays) || 0));
  next.idleDays = Math.min(3650, Math.max(30, Number(next.idleDays) || 365));
  next.backup.keepLocal = Math.min(60, Math.max(1, Number(next.backup.keepLocal) || 7));
  next.backup.keepExternal = Math.min(365, Math.max(1, Number(next.backup.keepExternal) || 30));
  next.backup.dir = String(next.backup.dir || '').trim();

  if (next.mail.enabled) {
    if (!next.mail.host) return { error: { status: 400, error: '要填 SMTP 服务器地址' } };
    if (!next.mail.user) return { error: { status: 400, error: '要填发信邮箱' } };
    if (!next.mail.pass) return { error: { status: 400, error: '要填授权码（QQ 邮箱在设置里生成，不是登录密码）' } };
    if (!next.mail.to) return { error: { status: 400, error: '要填收件邮箱' } };
  }

  db.setSetting(KEY, JSON.stringify(next));
  return { settings: publicView() };
}

/**
 * 取某类通知是否开启。
 * @param {string} kind expire|lowStock|lent|idle
 * @returns {boolean}
 */
function kindEnabled(kind) {
  return !!raw().kinds[kind];
}

/**
 * 邮件是否可发（开关打开 + 配置齐全）。
 * @returns {boolean}
 */
function mailReady() {
  const m = raw().mail;
  return !!(m.enabled && m.host && m.user && m.pass && m.to);
}

module.exports = {
  DEFAULTS,
  raw,
  publicView,
  save,
  kindEnabled,
  mailReady
};
