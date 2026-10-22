'use strict';

// 极简 HTTP 客户端。只用 node:http，不走系统代理（Windows 上 curl 会被 http_proxy 劫持，
// 所以测试里一律不用 curl）。

const httpMod = require('http');

const DEFAULT_TIMEOUT = 20000;

/**
 * 发一个请求。
 * @param {string} base 形如 http://127.0.0.1:1234
 * @param {string} method HTTP 方法
 * @param {string} urlPath 路径（可带查询串，需自行 encode）
 * @param {object} [opts] 选项
 * @param {*} [opts.body] 对象则 JSON 序列化；Buffer/string 原样发送
 * @param {Record<string,string>} [opts.headers] 额外头
 * @param {number} [opts.timeout] 超时毫秒
 * @returns {Promise<{status:number, headers:object, text:string, json:*, durationMs:number}>}
 */
function request(base, method, urlPath, opts) {
  const cfg = opts || {};
  return new Promise((resolve, reject) => {
    const url = new URL(base + urlPath);
    let payload = null;
    const headers = Object.assign({}, cfg.headers || {});
    if (cfg.body !== undefined && cfg.body !== null) {
      if (Buffer.isBuffer(cfg.body) || typeof cfg.body === 'string') {
        payload = Buffer.isBuffer(cfg.body) ? cfg.body : Buffer.from(cfg.body);
      } else {
        payload = Buffer.from(JSON.stringify(cfg.body), 'utf8');
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = payload.length;
    }
    const startedAt = Date.now();
    const req = httpMod.request({
      host: url.hostname,
      port: url.port,
      method,
      path: url.pathname + url.search,
      headers,
      timeout: cfg.timeout || DEFAULT_TIMEOUT,
      agent: false
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch (err) { json = undefined; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          raw,
          json,
          durationMs: Date.now() - startedAt
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('请求超时（' + (cfg.timeout || DEFAULT_TIMEOUT) + 'ms）'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 发一个「Content-Length 声明与实际不符」的请求，用来看服务端如何兜底。
 * @param {string} base 基地址
 * @param {string} method 方法
 * @param {string} urlPath 路径
 * @param {number} declaredLength 声明的长度
 * @param {Buffer} payload 实际内容
 * @returns {Promise<{status:number|null, error:string|null}>}
 */
function requestWithBadLength(base, method, urlPath, declaredLength, payload) {
  return new Promise((resolve) => {
    const url = new URL(base + urlPath);
    const req = httpMod.request({
      host: url.hostname,
      port: url.port,
      method,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': declaredLength
      },
      timeout: 8000,
      agent: false
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, error: null });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => resolve({ status: null, error: err.code || err.message }));
    // 写入后立即断掉，模拟「声明 10 字节却只给了 3 字节」这类客户端
    req.write(payload);
    setTimeout(() => { try { req.destroy(); } catch (err) { /* 已关 */ } }, 300);
  });
}

/**
 * 发一个「路径按原样送出去」的请求，不让 URL 解析器先做 ../ 归一化。
 * 测路径穿越必须用这个：new URL('http://h/../x') 会先把 ../ 吃掉，
 * 那样测的就不是服务端，而是我们自己的客户端。
 * @param {string} base 基地址（只取 host/port）
 * @param {string} method 方法
 * @param {string} rawPath 原样路径（含可能的 ../ 与百分号编码）
 * @returns {Promise<{status:number, headers:object, text:string, raw:Buffer}>}
 */
function requestRaw(base, method, rawPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = httpMod.request({
      host: url.hostname,
      port: url.port,
      method,
      path: rawPath,
      headers: { Host: url.host, Connection: 'close' },
      timeout: DEFAULT_TIMEOUT,
      agent: false
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: raw.toString('utf8'),
          raw
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { request, requestRaw, requestWithBadLength, DEFAULT_TIMEOUT };
