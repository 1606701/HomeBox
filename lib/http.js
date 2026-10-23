'use strict';

// HTTP 基础设施：JSON 响应、请求体读取、体积限制、静态文件
// 全部从原 server.js 平移，状态码、文案、响应头一字未改。

const fs = require('fs');
const path = require('path');

const MAX_BODY = 2 * 1024 * 1024;
// 照片走 base64，体积会膨胀约三分之一，所以单独放宽上限
const MAX_PHOTO_BODY = 9 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

// 静态资源根目录，由 configure() 注入（server.js 在启动时注入，P4 会在这里做版本号注入）
let publicDir = null;

/**
 * 注入静态资源根目录。
 * @param {{publicDir?:string}} opts 配置
 */
function configure(opts) {
  const cfg = opts || {};
  if (cfg.publicDir) publicDir = cfg.publicDir;
}

function getPublicDir() {
  if (!publicDir) throw new Error('静态资源目录还没配置，先调用 http.configure()');
  return publicDir;
}

/**
 * 发 JSON 响应。Cache-Control: no-store 保证手机端永远看到最新数据。
 * @param {import('http').ServerResponse} res 响应
 * @param {number} status HTTP 状态码
 * @param {*} payload 任意可序列化对象
 */
function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * 读并解析 JSON 请求体。空体返回 {}，与旧版一致（前端有些 POST 不带 body）。
 * @param {import('http').IncomingMessage} req 请求
 * @param {number} [maxSize] 上限，默认 MAX_BODY
 * @returns {Promise<object>} 解析结果
 */
function readBody(req, maxSize) {
  const limit = maxSize || MAX_BODY;
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      // 超限后不能直接 destroy 连接——那样响应根本发不回去，
      // 前端只会看到一句莫名其妙的 Failed to fetch。
      // 正确做法是把多余的数据读完丢掉，照常返回一个说得清的错误。
      if (tooBig) return;
      size += chunk.length;
      if (size > limit) { tooBig = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        const err = new Error(limit > MAX_BODY
          ? '这张图太大了，重新拍一张小的，或者从相册里选压缩过的版本'
          : '内容太大了');
        err.statusCode = 413;
        return reject(err);
      }
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 有 Content-Length 时先拦一道，省得把几 MB 无用数据读进来再丢。
 * @param {import('http').IncomingMessage} req 请求
 * @param {string} pathname 已解码的路径
 * @returns {boolean} 是否超限
 */
function tooLarge(req, pathname) {
  const declared = Number(req.headers['content-length']);
  if (!Number.isFinite(declared)) return false;
  const limit = /\/photo$/.test(pathname) ? MAX_PHOTO_BODY : MAX_BODY;
  return declared > limit;
}

/**
 * 静态文件服务。路径穿越一律 403，找不到 404。
 * @param {import('http').ServerResponse} res 响应
 * @param {string} pathname 已解码的路径
 */
function serveStatic(res, pathname) {
  const root = getPublicDir();
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400');
  }
  const full = path.join(root, rel);
  if (!full.startsWith(root)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

module.exports = {
  MAX_BODY,
  MAX_PHOTO_BODY,
  MIME,
  configure,
  getPublicDir,
  sendJSON,
  readBody,
  tooLarge,
  serveStatic
};
