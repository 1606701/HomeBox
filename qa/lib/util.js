'use strict';

// QA 测试脚手架：临时目录 / 端口 / 文件快照 / 异步等待
//
// 铁律：这里的任何函数都不允许碰仓库里的 data/。
// 所有读写都发生在 fs.mkdtempSync() 造出来的临时目录里。

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 造一个临时目录（调用方负责最终 rmrf）。
 * @param {string} [label] 前缀，方便在系统临时目录里辨认
 * @returns {string} 绝对路径
 */
function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), label || 'homebox-qa-'));
}

/**
 * 递归删除目录；Windows 上 WAL 句柄可能晚一拍释放，所以带重试。
 * @param {string} dir 目录
 */
function rmrf(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 });
  } catch (err) {
    // 清理失败不掩盖测试结论，但要留个痕迹
    console.warn('[qa] 临时目录清理失败：' + dir + '（' + err.message + '）');
  }
}

/**
 * 复制目录（保留文件内容，不保留时间戳）。
 * @param {string} src 源
 * @param {string} dst 目标
 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * 列出目录里的文件名（不存在时返回空数组）。
 * @param {string} dir 目录
 * @returns {string[]}
 */
function listFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => {
      try {
        return fs.statSync(path.join(dir, n)).isFile();
      } catch (err) {
        return false;
      }
    }).sort();
  } catch (err) {
    return [];
  }
}

/**
 * 单文件 sha256；文件不存在返回 null。
 * @param {string} file 文件路径
 * @returns {string|null}
 */
function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (err) {
    return null;
  }
}

/**
 * 给一批文件拍快照（大小 + mtime + sha256），用于证明「没被改动」。
 * @param {string[]} files 文件路径数组
 * @returns {Record<string, {size:number|null, mtimeMs:number|null, sha256:string|null}>}
 */
function snapshotFiles(files) {
  const out = {};
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      out[file] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha256File(file) };
    } catch (err) {
      out[file] = { size: null, mtimeMs: null, sha256: null };
    }
  }
  return out;
}

/**
 * 比较两份快照，返回变化的文件列表。
 * @param {object} before 之前的快照
 * @param {object} after 之后的快照
 * @returns {string[]} 变化的文件路径
 */
function diffSnapshot(before, after) {
  const changed = [];
  for (const key of Object.keys(before)) {
    const a = before[key];
    const b = after[key] || { size: null, mtimeMs: null, sha256: null };
    if (a.sha256 !== b.sha256 || a.size !== b.size) changed.push(key);
  }
  return changed;
}

/**
 * 拿一个当前空闲的端口。
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询直到条件成立。
 * @param {() => Promise<boolean>|boolean} fn 条件
 * @param {number} timeoutMs 超时
 * @param {number} [intervalMs] 间隔
 * @returns {Promise<boolean>} 成功 true，超时 false
 */
async function waitUntil(fn, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  const step = intervalMs || 100;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

/**
 * 把「只做一次」的异步初始化包起来：失败也会缓存失败结果，后续调用直接抛同一个错。
 * @param {Function} fn 初始化函数
 * @returns {Function} 返回 Promise 的函数
 */
function once(fn) {
  let cached = null;
  return function call() {
    if (!cached) cached = Promise.resolve().then(fn);
    return cached;
  };
}

module.exports = {
  REPO_ROOT,
  makeTempDir,
  rmrf,
  copyDir,
  listFiles,
  sha256File,
  snapshotFiles,
  diffSnapshot,
  freePort,
  sleep,
  waitUntil,
  once
};
