'use strict';

// 提醒：算「今天该关心哪些东西」
//
// 铁律（PRD P0-2 的验收点）：每条查询的第一个条件必须是 `IS NOT NULL`。
// 老数据这些字段全是空的，这条保证「升级当天不会被 26 件空字段物品轰炸」。
//
// 三类提醒 + 一类默认关闭的：
//   expire   快过期（提前 expireDays 天，可按物品单独设 remind_days）
//   lowStock 低于最低库存
//   lent     借出去超过 30 天没还
//   idle     很久没动过（默认关，开了才查）

const db = require('../db');
const locations = require('./locations');
const settings = require('./settings');

const LENT_DAYS = 30;

/**
 * 本地日期字符串 YYYY-MM-DD。树莓派没有 RTC，一律用本地时间，不用 UTC。
 * @param {Date} [d] 日期
 * @returns {string}
 */
function localDate(d) {
  const x = d || new Date();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return x.getFullYear() + '-' + m + '-' + day;
}

/**
 * 今天往后 n 天的本地日期。
 * @param {number} n 天数
 * @returns {string}
 */
function localDatePlus(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDate(d);
}

/**
 * 两个 YYYY-MM-DD 之间差几天（b - a）。
 * @param {string} a 起始日期
 * @param {string} b 结束日期
 * @returns {number}
 */
function daysBetween(a, b) {
  const t1 = new Date(a + 'T00:00:00').getTime();
  const t2 = new Date(b + 'T00:00:00').getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0;
  return Math.round((t2 - t1) / 86400000);
}

/**
 * 取一批物品的「已忽略 / 已处理」状态。
 * @param {string} today 今天
 * @returns {Map<string,{action:string,until:string|null,ackDate:string}>}
 */
function ackMap(today) {
  const out = new Map();
  db.prepare('SELECT * FROM reminder_acks').all().forEach((row) => {
    out.set(row.item_id + '|' + row.kind, {
      action: String(row.action),
      until: row.until_date ? String(row.until_date) : null,
      ackDate: String(row.ack_date)
    });
  });
  return out;
}

/**
 * 这条提醒现在该不该出现。
 * @param {object|undefined} ack 忽略记录
 * @param {string} today 今天
 * @returns {boolean} true = 显示
 */
function visible(ack, today) {
  if (!ack) return true;
  if (ack.action === 'mute') return false;                 // 永久不再提醒
  if (ack.action === 'done' && ack.ackDate === today) return false;  // 今天处理过了
  if (ack.action === 'snooze' && ack.until && ack.until >= today) return false; // 稍后再说
  return true;
}

/**
 * 把物品行包成提醒条目（不带金额，提醒页不需要）。
 * @param {object} row items 行
 * @param {Map} index 位置索引
 * @param {string} kind 类别
 * @param {object} extra 附加字段
 * @returns {object}
 */
function toEntry(row, index, kind, extra) {
  return Object.assign({
    id: String(row.id),
    name: String(row.name),
    qty: Number(row.qty),
    locId: row.loc_id ? String(row.loc_id) : null,
    path: locations.pathOf(index, row.loc_id),
    kind
  }, extra || {});
}

/**
 * 算出今天全部提醒。
 * @returns {object} 分组结果
 */
function compute() {
  const cfg = settings.raw();
  const today = localDate();
  const index = locations.pathIndex();
  const acks = ackMap(today);
  const groups = { expire: [], lowStock: [], lent: [], idle: [] };

  if (cfg.kinds.expire) {
    const rows = db.prepare('SELECT * FROM items WHERE expire_at IS NOT NULL ' +
      "AND state = 'in_use' AND date(expire_at) <= date(?, '+' || COALESCE(remind_days, ?) || ' days')")
      .all(today, cfg.expireDays);
    rows.forEach((row) => {
      const ack = acks.get(row.id + '|expire');
      if (!visible(ack, today)) return;
      groups.expire.push(toEntry(row, index, 'expire', {
        expireAt: String(row.expire_at),
        daysLeft: daysBetween(today, String(row.expire_at)),
        remindDays: row.remind_days == null ? cfg.expireDays : Number(row.remind_days)
      }));
    });
  }

  if (cfg.kinds.lowStock) {
    const rows = db.prepare('SELECT * FROM items WHERE min_qty IS NOT NULL ' +
      "AND state = 'in_use' AND qty < min_qty").all();
    rows.forEach((row) => {
      const ack = acks.get(row.id + '|lowStock');
      if (!visible(ack, today)) return;
      groups.lowStock.push(toEntry(row, index, 'lowStock', {
        qty: Number(row.qty), minQty: Number(row.min_qty)
      }));
    });
  }

  if (cfg.kinds.lent) {
    const rows = db.prepare("SELECT * FROM items WHERE lend_at IS NOT NULL AND state = 'lent' " +
      "AND julianday('now') - julianday(lend_at) >= ?").all(LENT_DAYS);
    rows.forEach((row) => {
      const ack = acks.get(row.id + '|lent');
      if (!visible(ack, today)) return;
      groups.lent.push(toEntry(row, index, 'lent', {
        lendTo: row.lend_to ? String(row.lend_to) : '',
        lendAt: row.lend_at ? String(row.lend_at).slice(0, 10) : null,
        daysLent: Math.floor((Date.now() - new Date(row.lend_at).getTime()) / 86400000)
      }));
    });
  }

  if (cfg.kinds.idle) {
    const rows = db.prepare("SELECT * FROM items WHERE state = 'in_use' " +
      'AND date(updated_at) <= date(?, ?)').all(localDatePlus(-cfg.idleDays));
    rows.forEach((row) => {
      const ack = acks.get(row.id + '|idle');
      if (!visible(ack, today)) return;
      groups.idle.push(toEntry(row, index, 'idle', {
        idleDays: daysBetween(String(row.updated_at).slice(0, 10), today)
      }));
    });
  }

  const counts = {
    expire: groups.expire.length,
    lowStock: groups.lowStock.length,
    lent: groups.lent.length,
    idle: groups.idle.length
  };
  counts.total = counts.expire + counts.lowStock + counts.lent + counts.idle;

  return { today, groups, counts };
}

/**
 * 处理一条提醒。
 * @param {string} itemId 物品 id
 * @param {string} kind 类别
 * @param {string} action done|snooze|mute
 * @returns {{error?:{status:number,error:string}, ok?:boolean}}
 */
function ack(itemId, kind, action) {
  const KINDS = ['expire', 'lowStock', 'lent', 'idle'];
  if (KINDS.indexOf(kind) === -1) {
    return { error: { status: 400, error: '不认识的提醒类型' } };
  }
  if (['done', 'snooze', 'mute'].indexOf(action) === -1) {
    return { error: { status: 400, error: '不认识的处置方式' } };
  }
  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(itemId);
  if (!item) return { error: { status: 404, error: '物品不存在' } };

  const today = localDate();
  const until = action === 'snooze' ? localDatePlus(7) : null;
  db.tx(() => {
    db.prepare('INSERT INTO reminder_acks (item_id, kind, action, until_date, ack_date) ' +
      'VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(item_id, kind) DO UPDATE SET action = excluded.action, ' +
      'until_date = excluded.until_date, ack_date = excluded.ack_date')
      .run(itemId, kind, action, until, today);
  });
  return { ok: true };
}

/**
 * 邮件用：今天该进邮件、且 7 天内没发过的。
 * 同一件东西同类提醒 7 天只发一次，否则用户第一件事就是关掉全部通知。
 * @returns {object} 分组结果（结构与 compute 一致）
 */
function dueForMail() {
  const all = compute();
  const today = localDate();
  const recent = new Set();
  db.prepare('SELECT item_id, kind FROM notify_log WHERE channel = \'mail\' ' +
    'AND sent_date > date(?, \'-7 days\')').all(today).forEach((row) => {
    recent.add(row.item_id + '|' + row.kind);
  });

  const groups = { expire: [], lowStock: [], lent: [], idle: [] };
  Object.keys(groups).forEach((k) => {
    groups[k] = all.groups[k].filter((e) => !recent.has(e.id + '|' + k));
  });
  const counts = {
    expire: groups.expire.length,
    lowStock: groups.lowStock.length,
    lent: groups.lent.length,
    idle: groups.idle.length
  };
  counts.total = counts.expire + counts.lowStock + counts.lent + counts.idle;
  return { today: all.today, groups, counts };
}

/**
 * 记一笔「这个提醒已经发过邮件」，用于 7 天收敛。
 * @param {object} groups compute/dueForMail 的 groups
 * @param {string} today 日期
 */
function markNotified(groups, today) {
  const stmt = db.prepare('INSERT OR IGNORE INTO notify_log ' +
    '(item_id, kind, channel, sent_date) VALUES (?, ?, ?, ?)');
  Object.keys(groups).forEach((kind) => {
    groups[kind].forEach((entry) => {
      stmt.run(entry.id, kind, 'mail', today);
    });
  });
}

module.exports = {
  LENT_DAYS,
  localDate,
  localDatePlus,
  daysBetween,
  compute,
  ack,
  dueForMail,
  markNotified
};
