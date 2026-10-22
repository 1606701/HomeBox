'use strict';

// 价值统计：按位置 / 类目 / 成员三个维度聚合，外加「覆盖率」
//
// 两个必须分开的口径（PRD P0-3）：
//   · inUseCents  在库价值：只算 state='in_use'（家里现在这些东西值多少）
//   · allCents    累计购入：所有状态（历史一共花了多少）
// 未填价的物品不计入金额，但单独计数，绝不能显示成 ¥0.00 —— 那会让人以为家里东西不值钱。

const db = require('../db');
const locations = require('./locations');
const members = require('./members');

const UNCATEGORIZED = '未分类';
const UNASSIGNED = '未指定';

/**
 * 单值查询，SUM 在没有行时返回 null，这里统一成 0。
 * @param {string} sql SQL（字面量）
 * @returns {number} 分值
 */
function sumOr0(sql) {
  const row = db.prepare(sql).get();
  const v = row ? Object.values(row)[0] : null;
  return v == null ? 0 : Number(v);
}

/**
 * 覆盖率与总额。
 * @returns {{inUseCents:number, allCents:number, count:number, recorded:number, unrecorded:number}}
 */
function totals() {
  const count = sumOr0('SELECT COUNT(*) FROM items');
  const recorded = sumOr0('SELECT COUNT(*) FROM items WHERE price_cents IS NOT NULL');
  return {
    inUseCents: sumOr0("SELECT SUM(price_cents * qty) FROM items WHERE state = 'in_use'"),
    allCents: sumOr0('SELECT SUM(price_cents * qty) FROM items'),
    count,
    recorded,
    unrecorded: count - recorded
  };
}

/**
 * 每个位置的直接金额（不含子位置）。
 * @returns {Map<string,{valueCents:number,count:number}>}
 */
function directByLoc() {
  const out = new Map();
  db.prepare('SELECT loc_id, SUM(price_cents * qty) AS v, COUNT(*) AS c FROM items ' +
    'WHERE price_cents IS NOT NULL GROUP BY loc_id').all().forEach((row) => {
    out.set(row.loc_id == null ? '' : String(row.loc_id), {
      valueCents: Number(row.v) || 0,
      count: Number(row.c) || 0
    });
  });
  return out;
}

/**
 * 按房间汇总（物品挂在抽屉上也要算进所属房间）。
 * @returns {{key:string,name:string,valueCents:number,count:number}[]}
 */
function byLocation() {
  const flat = locations.list();
  const byId = new Map(flat.map((l) => [l.id, l]));
  const direct = directByLoc();
  const bucket = new Map();

  // 从物品所在位置往上找第一个 room（找不到就用根节点）
  const roomOf = (locId) => {
    let cur = locId ? byId.get(locId) : null;
    let guard = 0;
    let fallback = null;
    while (cur && guard < 32) {
      if (cur.kind === 'room') return cur;
      if (cur.kind === 'home') fallback = cur;
      cur = cur.parent ? byId.get(cur.parent) : null;
      guard += 1;
    }
    return fallback || null;
  };

  direct.forEach((agg, locId) => {
    const room = roomOf(locId);
    const key = room ? room.id : '';
    const name = room ? room.name : '未归档';
    if (!bucket.has(key)) bucket.set(key, { key, name, valueCents: 0, count: 0 });
    const b = bucket.get(key);
    b.valueCents += agg.valueCents;
    b.count += agg.count;
  });

  // 没填价的物品也要出现在「件数」里，否则用户会以为某个房间没东西
  db.prepare('SELECT loc_id, COUNT(*) AS c FROM items WHERE price_cents IS NULL GROUP BY loc_id')
    .all().forEach((row) => {
      const room = roomOf(row.loc_id == null ? '' : String(row.loc_id));
      const key = room ? room.id : '';
      const name = room ? room.name : '未归档';
      if (!bucket.has(key)) bucket.set(key, { key, name, valueCents: 0, count: 0 });
      bucket.get(key).count += Number(row.c) || 0;
    });

  return Array.from(bucket.values()).sort((a, b) => b.valueCents - a.valueCents);
}

/**
 * 按类目汇总。
 * @returns {{key:string,name:string,valueCents:number,count:number}[]}
 */
function byCategory() {
  const rows = db.prepare('SELECT COALESCE(NULLIF(category, \'\'), ?) AS k, ' +
    'SUM(price_cents * qty) AS v, COUNT(*) AS c FROM items GROUP BY k').all(UNCATEGORIZED);
  return rows.map((row) => ({
    key: String(row.k),
    name: String(row.k),
    valueCents: Number(row.v) || 0,
    count: Number(row.c) || 0
  })).sort((a, b) => b.valueCents - a.valueCents);
}

/**
 * 按成员汇总。
 * @returns {{key:string,name:string,valueCents:number,count:number}[]}
 */
function byOwner() {
  const names = new Map(members.list().map((m) => [m.id, m.name]));
  const rows = db.prepare('SELECT owner_id, SUM(price_cents * qty) AS v, COUNT(*) AS c ' +
    'FROM items GROUP BY owner_id').all();
  return rows.map((row) => {
    const key = row.owner_id == null ? '' : String(row.owner_id);
    return {
      key,
      name: key ? (names.get(key) || '已删除成员') : UNASSIGNED,
      valueCents: Number(row.v) || 0,
      count: Number(row.c) || 0
    };
  }).sort((a, b) => b.valueCents - a.valueCents);
}

/**
 * 价值统计总入口（GET /api/stats/value）。
 * @param {object} [opts] 选项
 * @param {string} [opts.by] loc | category | owner
 * @returns {object} 统计结构
 */
function value(opts) {
  const by = (opts && opts.by) || 'loc';
  let groups;
  if (by === 'category') groups = byCategory();
  else if (by === 'owner') groups = byOwner();
  else groups = byLocation();
  return { currency: 'CNY', by: ['loc', 'category', 'owner'].indexOf(by) !== -1 ? by : 'loc',
    totals: totals(), groups };
}

/**
 * 给位置树节点补上「这一处合计值多少钱」（地图详情里显示）。
 * @param {object[]} tree buildTree 的结果
 * @returns {object[]} 同一棵树
 */
function decorateTree(tree) {
  const direct = directByLoc();
  const walk = (node) => {
    const self = direct.get(node.id);
    let sum = self ? self.valueCents : 0;
    node.children.forEach((child) => { sum += walk(child); });
    node.valueCents = sum;
    return sum;
  };
  tree.forEach(walk);
  return tree;
}

module.exports = {
  UNCATEGORIZED,
  UNASSIGNED,
  totals,
  value,
  decorateTree
};
