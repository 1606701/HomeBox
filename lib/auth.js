'use strict';

// 鉴权：scrypt 密码哈希 + HMAC 签名的无状态 Cookie
//
// 为什么不用 session 表和 JWT 库（见 ARCHITECTURE.md §4.1）：
//   · session 表要做滑动过期，等于每个请求都写一次 TF 卡 —— 与这个项目的定位冲突；
//   · JWT 库只是把「签一个 HMAC」包装了一遍，Node 内置 crypto 十行就能做完。
// 代价是没有服务端撤销能力，用 members.pass_ver（改密码 +1）补回来：
//   Cookie 里带着签发时的 pass_ver，和库里的对不上就作废。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'hb_sid';
const MAX_AGE_SEC = 7 * 24 * 3600;   // 7 天
const REFRESH_BELOW_SEC = 3 * 24 * 3600; // 剩余不足 3 天时静默续期

// scrypt 参数：ARM 上约 50-100ms，登录态完全够用
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

let secret = null;
let keyFile = null;

/**
 * 注入数据目录并加载（或生成）签名密钥。
 * @param {{dataDir:string}} opts 配置
 */
function configure(opts) {
  const dataDir = opts && opts.dataDir;
  if (!dataDir) throw new Error('auth.configure 需要 dataDir');
  keyFile = path.join(dataDir, 'secret.key');
  try {
    secret = fs.readFileSync(keyFile);
  } catch (err) {
    // 首次启动生成一把随机密钥。删掉它 = 所有人重新登录（相当于「退出所有设备」）
    secret = crypto.randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyFile, secret, { mode: 0o600 });
  }
  if (!secret || secret.length < 16) throw new Error('签名密钥不可用：' + keyFile);
}

/* ---------- 密码 ---------- */

/**
 * 生成 `scrypt$N$r$p$salt$hash` 形状的密码串。
 * @param {string} password 明文密码
 * @returns {string} 可入库的哈希串
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN,
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P,
    salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * 校验密码。用 timingSafeEqual 比较，避免按字节短路泄漏信息。
 * @param {string} password 明文
 * @param {string} stored 入库的哈希串
 * @returns {boolean} 是否匹配
 */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  let salt;
  let expect;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expect = Buffer.from(parts[5], 'base64');
  } catch (err) {
    return false;
  }
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expect.length, { N: n, r, p });
  } catch (err) {
    return false;
  }
  return actual.length === expect.length && crypto.timingSafeEqual(actual, expect);
}

/**
 * 生成 8 位恢复码（装机时打印出来抄在路由器背面，忘记密码用）。
 * @returns {string} 形如 `7K2M-9QX4`
 */
function makeRecoverCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out.slice(0, 4) + '-' + out.slice(4);
}

/* ---------- Cookie 签名 ---------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * 签发会话串：payload.signature。
 * @param {{id:string,role:string,passVer:number}} member 成员
 * @returns {string} Cookie 值
 */
function signSession(member) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SEC;
  const payload = JSON.stringify({
    m: member.id, r: member.role, v: Number(member.passVer) || 0, e: exp
  });
  const body = b64url(payload);
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}

/**
 * 校验并解出会话内容。
 * @param {string} raw Cookie 值
 * @returns {{m:string,r:string,v:number,e:number}|null} 合法返回载荷，否则 null
 */
function readSession(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload.m !== 'string') return null;
  if (!Number.isFinite(payload.e) || payload.e * 1000 < Date.now()) return null;
  return payload;
}

/**
 * 从请求头里取 Cookie。
 * @param {import('http').IncomingMessage} req 请求
 * @param {string} name Cookie 名
 * @returns {string|null} 值
 */
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const parts = String(raw).split(';');
  for (let i = 0; i < parts.length; i += 1) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    if (parts[i].slice(0, eq).trim() === name) {
      return decodeURIComponent(parts[i].slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * 写会话 Cookie。局域网 http 下不能标 Secure（浏览器会直接丢掉，全员登不上），
 * 所以按连接是否加密动态决定。
 * @param {import('http').ServerResponse} res 响应
 * @param {object} member 成员
 * @param {import('http').IncomingMessage} req 请求
 */
function setSessionCookie(res, member, req) {
  const secure = !!(req && req.socket && req.socket.encrypted);
  const parts = [
    COOKIE + '=' + encodeURIComponent(signSession(member)),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + MAX_AGE_SEC
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * 清 Cookie（退出）。
 * @param {import('http').ServerResponse} res 响应
 */
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/**
 * 解析当前请求的身份。
 * @param {import('http').IncomingMessage} req 请求
 * @param {{members:object, roles:object}} deps 依赖注入，避免循环 require
 * @returns {{member:object|null, role:string, caps:object, bootstrap:boolean, needSetup:boolean, renew:boolean}}
 */
function context(req, deps) {
  const members = deps.members;
  const roles = deps.roles;
  const total = members.count();

  // 没有任何成员 = 首次使用（或从 v1 升级上来还没建管理员）。
  // 这段时间按管理员对待：既能建第一个管理员，也不会把老用户挡在门外。
  if (total === 0) {
    return {
      member: { id: 'm_bootstrap', name: '本机', role: 'admin' },
      role: 'admin',
      caps: roles.capsOf('admin'),
      bootstrap: true,
      needSetup: true,
      renew: false
    };
  }

  const payload = readSession(readCookie(req, COOKIE));
  const member = payload ? members.getAuth(payload.m) : null;
  // pass_ver 对不上 = 改过密码 / 已被删除 / 被撤销，一律当未登录
  if (!member || Number(member.passVer) !== Number(payload.v)) {
    return {
      member: null, role: 'guest', caps: roles.capsOf('guest'),
      bootstrap: false, needSetup: false, renew: false
    };
  }

  const left = payload.e - Math.floor(Date.now() / 1000);
  return {
    member,
    role: roles.validRole(member.role),
    caps: roles.capsOf(member.role),
    bootstrap: false,
    needSetup: false,
    renew: left < REFRESH_BELOW_SEC
  };
}

module.exports = {
  COOKIE,
  configure,
  hashPassword,
  verifyPassword,
  makeRecoverCode,
  signSession,
  readSession,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  context
};
