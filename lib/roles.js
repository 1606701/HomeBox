'use strict';

// 角色能力表 + 按角色裁剪返回字段
//
// 设计要点（见 docs/v2/ARCHITECTURE.md §4.2）：
//   · 金额一律在**服务端序列化出口**裁剪，不做「前端隐藏」。前端隐藏挡不住直接调接口。
//   · 全项目只有这个文件决定「谁能看金额」，将来加角色只改 CAPS。
//   · 裁剪是**删字段**，不是置 0 —— 前端拿不到 key 就不可能误显示成 ¥0.00。

const ROLES = [
  { k: 'admin', n: '管理员' },
  { k: 'member', n: '成员' },
  { k: 'simple', n: '精简' },
  { k: 'guest', n: '访客' }
];

const ROLE_KEYS = ROLES.map((r) => r.k);

// 能力表：增删一个能力只改这里
const CAPS = {
  // 管理员：全部
  admin: { seePrice: true, write: true, remove: true, members: true, stats: true, settings: true },
  // 成员：能记、能改、能删、能看钱，但不管人和系统设置
  member: { seePrice: true, write: true, remove: true, members: false, stats: true, settings: false },
  // 精简：能记能改（给老人用），看不到钱，也不给删（误触代价太大）
  simple: { seePrice: false, write: true, remove: false, members: false, stats: false, settings: false },
  // 访客：只读
  guest: { seePrice: false, write: false, remove: false, members: false, stats: false, settings: false }
};

/**
 * 合法角色枚举校验，非法值一律降级成访客（最小权限原则）。
 * @param {*} role 角色字符串
 * @returns {string} 合法角色
 */
function validRole(role) {
  return ROLE_KEYS.indexOf(role) !== -1 ? role : 'guest';
}

/**
 * 取某角色的能力表。
 * @param {string} role 角色
 * @returns {{seePrice:boolean,write:boolean,remove:boolean,members:boolean,stats:boolean,settings:boolean}}
 */
function capsOf(role) {
  return CAPS[validRole(role)];
}

/**
 * 判断角色是否具备某项能力。
 * @param {string} role 角色
 * @param {string} cap 能力名
 * @returns {boolean}
 */
function can(role, cap) {
  return !!capsOf(role)[cap];
}

/**
 * 物品按角色裁剪：不给看价的角色，直接把金额字段删掉。
 * @param {object} item API 形状的物品
 * @param {string} role 角色
 * @returns {object} 新对象（不改原对象）
 */
function forItem(item, role) {
  if (!item) return item;
  const out = Object.assign({}, item);
  if (!can(role, 'seePrice')) {
    delete out.priceCents;
    delete out.buyDate;
    delete out.valueCents;
  }
  return out;
}

/**
 * 位置节点按角色裁剪：节点上挂着「这一处值多少钱」，精简/访客看不到。
 * @param {object[]} nodes 位置树（会被递归处理）
 * @param {string} role 角色
 * @returns {object[]} 同一批节点（原地裁剪，调用方持有的是刚构建的新对象）
 */
function forTree(nodes, role) {
  if (!can(role, 'seePrice')) {
    const walk = (node) => {
      delete node.valueCents;
      (node.children || []).forEach(walk);
    };
    nodes.forEach(walk);
  }
  return nodes;
}

/**
 * 统计结果按角色裁剪（防御性：统计接口本身已经要求 stats 能力）。
 * @param {object} stats 统计结构
 * @param {string} role 角色
 * @returns {object} 同一对象
 */
function forStats(stats, role) {
  if (!can(role, 'seePrice')) {
    delete stats.totals;
    (stats.groups || []).forEach((g) => { delete g.valueCents; });
  }
  return stats;
}

module.exports = {
  ROLES,
  ROLE_KEYS,
  CAPS,
  validRole,
  capsOf,
  can,
  forItem,
  forTree,
  forStats
};
