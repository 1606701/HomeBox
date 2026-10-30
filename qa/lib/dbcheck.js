'use strict';

// 直接读 SQLite 用的辅助函数（只给测试用，生产代码只有 lib/db.js 碰 node:sqlite）。
// 一律以只读方式打开迁出来的临时库，读完整行做「逐字段」核对。

const fs = require('fs');
const path = require('path');
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

/**
 * 同步等待（只用于只读重试，不引入 Promise）。
 * @param {number} ms 毫秒
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 数目录下的文件个数（目录不存在算 0）。
 * @param {string} dir 目录
 * @returns {number}
 */
function countFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile()).length;
  } catch (err) {
    return 0;
  }
}

/**
 * 真实库的「逻辑数据」四项计数。
 *
 * 这是「测试有没有真动用户数据」的主判据：比 WAL 字节可靠得多，
 * 不受 checkpoint 时机影响。四项分别是
 *   locations 行数 / items 行数 / wear 件数（wear_json 非空）/ photos 文件数。
 *
 * 全程**只读**打开（readOnly: true）。用只读连接是硬要求：
 * 可写连接会自己产生 -wal/-shm 写入，那测试自身就成了污染源。
 *
 * @param {string} dataDir 真实数据目录（.../data）
 * @returns {{locations:number, items:number, wear:number, photos:number}}
 */
function logicalCounts(dataDir) {
  const dbFile = path.join(dataDir, 'homebox.db');
  let lastErr = null;
  // 常驻实例可能正好在 checkpoint，只读连接偶发 SQLITE_BUSY，重试几次即可
  for (let i = 0; i < 5; i += 1) {
    try {
      return {
        locations: countRows(dbFile, 'locations'),
        items: countRows(dbFile, 'items'),
        wear: Number(query(dbFile,
          "SELECT COUNT(*) AS c FROM items WHERE wear_json IS NOT NULL AND wear_json <> ''")[0].c),
        photos: countFiles(path.join(dataDir, 'photos'))
      };
    } catch (err) {
      lastErr = err;
      sleepSync(60);
    }
  }
  throw new Error('只读统计真实库失败：' + (lastErr && lastErr.message));
}

/**
 * 比较两份逻辑计数，返回不一致的字段名。
 * @param {object} before 之前
 * @param {object} after 之后
 * @returns {string[]}
 */
function diffCounts(before, after) {
  return ['locations', 'items', 'wear', 'photos'].filter((k) =>
    Number(before[k]) !== Number(after[k]));
}

/**
 * 把计数渲染成一行，便于报告。
 * @param {object} c 计数
 * @returns {string}
 */
function describeCounts(c) {
  return 'locations=' + c.locations + ' items=' + c.items +
    ' wear=' + c.wear + ' photos=' + c.photos;
}

module.exports = {
  query,
  locations,
  items,
  setting,
  countRows,
  logicalCounts,
  diffCounts,
  describeCounts
};
