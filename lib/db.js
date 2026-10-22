'use strict';

// 数据库门面（全项目唯一 require('node:sqlite') 的地方）
//
// 为什么收敛到一个文件：Node 22 上 node:sqlite 仍是 Stability 1.2（RC），
// API 有可能微调；只要在 lib/db.js 里包一层，将来升级 Node 的改动只需改这里。
//
// 另外两个必须记住的事实：
//   1. node:sqlite 没有 db.transaction()（ADK 里那套是 better-sqlite3 的），事务一律手写
//      BEGIN / COMMIT / ROLLBACK，见 tx()。
//   2. PRAGMA foreign_keys 是「每条连接各自一份」的开关，必须显式打开。
//      SQLite 本身的默认是关的；node:sqlite 的 DatabaseSync 目前会在构造时替你打开
//      （enableForeignKeyConstraints 默认 true，已实测），但那是构造参数、可以关掉，
//      换连接或换版本也可能变 —— 显式写出来才不用赌实现细节。
//      不开的后果是静默的：ON DELETE SET NULL 失效，删位置不会把物品置空，不报错也不 500。

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATIONS, SCHEMA_VERSION } = require('./schema');

let handle = null;
let currentFile = null;
// 预处理语句缓存：同一个 SQL 只 prepare 一次
const stmtCache = new Map();
// 事务嵌套深度：外层真正 BEGIN，内层直接跟着外层走（SAVEPOINT 在这里没有必要）
let txDepth = 0;

/**
 * 打开数据库并应用 PRAGMA。重复调用同一路径是幂等的。
 * @param {string} file 数据库文件路径，或 ':memory:'
 * @returns {import('node:sqlite').DatabaseSync}
 */
function open(file) {
  if (handle) {
    if (currentFile && currentFile !== file) {
      throw new Error('数据库已经打开为 ' + currentFile + '，不能再打开 ' + file);
    }
    return handle;
  }
  const dir = path.dirname(file);
  if (file !== ':memory:') fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(file);

  // PRAGMA 取值照抄 docs/v2/ARCHITECTURE.md §2.3
  db.exec('PRAGMA journal_mode = WAL');        // 读写不互斥，断电不留半截文件
  db.exec('PRAGMA synchronous = NORMAL');      // FULL 每次 commit 双 fsync，卡寿命代价翻倍
  db.exec('PRAGMA busy_timeout = 5000');       // 两人同点「已买」时排队 5 秒而非立即报错
  db.exec('PRAGMA foreign_keys = ON');         // 显式开：SQLite 默认关，node:sqlite 封装默认开，不赌默认值
  db.exec('PRAGMA wal_autocheckpoint = 1000'); // 约 4MB 回写，防 -wal 膨胀

  handle = db;
  currentFile = file;
  stmtCache.clear();
  txDepth = 0;
  return db;
}

/**
 * 确保数据库已打开；没打开就按给定文件打开。
 * @param {string} file 数据库文件路径
 * @returns {import('node:sqlite').DatabaseSync}
 */
function ensureOpen(file) {
  if (handle) return handle;
  return open(file);
}

function get() {
  if (!handle) throw new Error('数据库还没打开，先调用 db.open()');
  return handle;
}

/**
 * 取一条缓存的预处理语句。
 * @param {string} sql SQL 文本（必须是字面量，不能拼接用户输入）
 * @returns {import('node:sqlite').StatementSync}
 */
function prepare(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = get().prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

// 无参语句直接跑，返回值丢弃
function exec(sql) {
  return get().exec(sql);
}

/**
 * 手写事务包装。回调抛错则整体回滚，并把错误继续抛出去。
 * 支持嵌套：内层不再 BEGIN，跟随最外层事务一起提交/回滚。
 * @template T
 * @param {() => T} fn 事务内要做的事
 * @returns {T} fn 的返回值
 */
function tx(fn) {
  const db = get();
  if (txDepth > 0) {
    txDepth += 1;
    try {
      return fn();
    } finally {
      txDepth -= 1;
    }
  }
  // IMMEDIATE：一开始就拿写锁，避免「先读后写」时的锁升级死锁
  db.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackErr) {
      // 回滚本身失败只可能发生在连接已坏的情况，把原始错误留在栈里更有价值
      console.error('[db] 回滚失败：', rollbackErr.message);
    }
    throw err;
  } finally {
    txDepth = 0;
  }
}

/**
 * 读取 PRAGMA user_version。
 * @returns {number}
 */
function userVersion() {
  const row = get().prepare('PRAGMA user_version').get();
  return Number(row && row.user_version) || 0;
}

/**
 * 按 MIGRATIONS 数组逐条跑 schema 迁移，每条包一个事务。
 * @returns {{from:number,to:number,applied:string[]}}
 */
function migrateSchema() {
  const db = get();
  const from = userVersion();
  let cur = from;
  const applied = [];
  for (let i = 0; i < MIGRATIONS.length; i += 1) {
    const step = MIGRATIONS[i];
    if (step.version <= cur) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      step.up(db);
      // PRAGMA 不能带占位符，只能拼字面量（version 来自代码常量，不是外部输入）
      db.exec('PRAGMA user_version = ' + Number(step.version));
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[db] 迁移回滚失败：', rollbackErr.message);
      }
      const wrapped = new Error('schema 迁移到 v' + step.version + ' 失败：' + err.message);
      wrapped.fatal = true;
      throw wrapped;
    }
    cur = step.version;
    applied.push('v' + step.version + ' ' + step.name);
  }
  return { from, to: cur, applied };
}

/**
 * 启动自检。失败说明文件真的坏了，必须拒绝启动，绝不能带着坏库继续跑。
 * @returns {{ok:boolean, rows:string[]}}
 */
function integrityCheck() {
  let rows;
  try {
    rows = get().prepare('PRAGMA integrity_check').all().map((r) => String(r.integrity_check));
  } catch (err) {
    return { ok: false, rows: [err.message] };
  }
  return { ok: rows.length === 1 && rows[0] === 'ok', rows };
}

/* ---------- settings（KV） ---------- */

/**
 * 读一个 KV 设置。
 * @param {string} key 键
 * @param {string|null} fallback 缺失时的兜底值
 * @returns {string|null}
 */
function getSetting(key, fallback) {
  const row = prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback === undefined ? null : fallback;
  return String(row.value);
}

/**
 * 写一个 KV 设置（有则更新，无则插入）。
 * @param {string} key 键
 * @param {*} value 值（统一按字符串存）
 */
function setSetting(key, value) {
  prepare('INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function close() {
  if (!handle) return;
  try {
    handle.close();
  } finally {
    handle = null;
    currentFile = null;
    stmtCache.clear();
    txDepth = 0;
  }
}

/**
 * 版本信息，启动日志里打一行，出问题时能一眼看出是哪个 Node / SQLite。
 * @returns {{node:string, sqlite:string, schemaVersion:number}}
 */
function info() {
  let sqlite = 'unknown';
  try {
    const row = get().prepare('SELECT sqlite_version() AS v').get();
    sqlite = row ? String(row.v) : 'unknown';
  } catch (err) {
    sqlite = 'unknown';
  }
  return { node: process.version, sqlite, schemaVersion: SCHEMA_VERSION };
}

module.exports = {
  open,
  ensureOpen,
  get,
  prepare,
  exec,
  tx,
  userVersion,
  migrateSchema,
  integrityCheck,
  getSetting,
  setSetting,
  close,
  info
};
