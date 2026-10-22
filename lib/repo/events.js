'use strict';

// 变更留痕（events 表）
//
// P1 阶段还没有任何接口读它，但它必须先写起来：等 P2 的时间线功能上线时，
// 用户手上的数据要能倒着说清「什么时候从哪挪到哪」。写入成本是一条 INSERT，
// 都发生在已有事务里，不额外吃一次 fsync。

const db = require('../db');
const { nowISO } = require('../util');

// 允许的变更类型，写错类型在开发期就能被这里挡住
const KINDS = [
  'create', 'update', 'move', 'qty', 'lend', 'return',
  'discard', 'used_up', 'photo', 'wear', 'migrate_v1'
];

/**
 * 写一条留痕。
 * @param {object} ev 事件
 * @param {string} ev.itemId 物品 id
 * @param {string} ev.kind 类型，见 KINDS
 * @param {string|null} [ev.memberId] 操作人（P2 起才有）
 * @param {*} [ev.payload] 附加信息，会被 JSON 序列化
 * @returns {void}
 */
function log(ev) {
  const kind = KINDS.indexOf(ev.kind) !== -1 ? ev.kind : 'update';
  let payload = null;
  if (ev.payload !== undefined && ev.payload !== null) {
    try {
      payload = JSON.stringify(ev.payload);
    } catch (err) {
      payload = null;
    }
  }
  db.prepare('INSERT INTO events (item_id, member_id, kind, payload, created_at) ' +
    'VALUES (?, ?, ?, ?, ?)')
    .run(ev.itemId, ev.memberId || null, kind, payload, nowISO());
}

/**
 * 读一件东西的时间线（P2 的 GET /api/items/:id/events 直接用）。
 * @param {string} itemId 物品 id
 * @param {number} [limit] 条数上限
 * @returns {Array<{id:number,kind:string,payload:*,createdAt:string}>}
 */
function timeline(itemId, limit) {
  const cap = Number(limit) > 0 ? Math.floor(Number(limit)) : 100;
  const rows = db.prepare('SELECT id, kind, payload, member_id, created_at FROM events ' +
    'WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(itemId, cap);
  return rows.map((row) => {
    let payload = null;
    if (row.payload) {
      try { payload = JSON.parse(String(row.payload)); } catch (err) { payload = null; }
    }
    return {
      id: Number(row.id),
      kind: String(row.kind),
      memberId: row.member_id ? String(row.member_id) : null,
      payload,
      createdAt: String(row.created_at)
    };
  });
}

/**
 * 统计某类留痕条数（迁移验收 / 冒烟测试用）。
 * @param {string} itemId 物品 id
 * @param {string} [kind] 类型，省略则统计全部
 * @returns {number}
 */
function count(itemId, kind) {
  const row = kind
    ? db.prepare('SELECT COUNT(*) AS c FROM events WHERE item_id = ? AND kind = ?').get(itemId, kind)
    : db.prepare('SELECT COUNT(*) AS c FROM events WHERE item_id = ?').get(itemId);
  return Number(row ? row.c : 0);
}

module.exports = { KINDS, log, timeline, count };
