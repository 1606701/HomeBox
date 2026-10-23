'use strict';

// 直接读 SQLite 用的辅助函数（只给测试用，生产代码只有 lib/db.js 碰 node:sqlite）。
// 一律以只读方式打开迁出来的临时库，读完整行做「逐字段」核对。

const { DatabaseSync } = require('node:sqlite');

/**
 * 以只读方式打开库并执行一个查询，用完立刻关。
 * @param {string} file 数据库文件
 * @param {string} sql SQL（无参数占位）
 * @param {Array} [params] 参数
 * @returns {object[]} 行数组
 */
function query(file, sql, params) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...(params || []));
  } finally {
    db.close();
  }
}

/**
 * 取全部位置行（含四列坐标），按 sort_order。
 * @param {string} file 数据库文件
 * @returns {object[]}
 */
function locations(file) {
  return query(file, 'SELECT * FROM locations ORDER BY sort_order ASC, rowid ASC');
}

/**
 * 取全部物品行，按旧数组顺序（rowid 升序）——注意不是接口顺序。
 * @param {string} file 数据库文件
 * @returns {object[]}
 */
function items(file) {
  return query(file, 'SELECT * FROM items ORDER BY rowid ASC');
}

/**
 * 取一个 KV 设置。
 * @param {string} file 数据库文件
 * @param {string} key 键
 * @returns {string|null}
 */
function setting(file, key) {
  const rows = query(file, 'SELECT value FROM settings WHERE key = ?', [key]);
  return rows.length ? String(rows[0].value) : null;
}

/**
 * 计表行数。
 * @param {string} file 数据库文件
 * @param {string} table 表名（白名单之外的调用会直接抛错）
 * @returns {number}
 */
function countRows(file, table) {
  const allowed = ['locations', 'items', 'events', 'settings', 'members', 'reminder_acks'];
  if (allowed.indexOf(table) === -1) throw new Error('不支持的统计表：' + table);
  const rows = query(file, 'SELECT COUNT(*) AS c FROM ' + table);
  return Number(rows[0].c);
}

module.exports = { query, locations, items, setting, countRows };
