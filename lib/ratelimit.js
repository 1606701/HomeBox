'use strict';

// 登录失败限流
//
// 为什么需要：scrypt 一次约 50-100ms，暴力破解本来就慢，但「慢」不等于「拦得住」——
// 一秒钟十次、一晚上两万次，对 6 位数字密码是够的。家里局域网不等于可信网络
// （访客 Wi-Fi、被蹭网、孩子拿着手机乱试都算）。
//
// 为什么放内存不放库：
//   1. 每次失败都写一次 TF 卡，和这个项目的定位直接冲突（见 lib/auth.js 顶部同样的论证）；
//   2. 攻击者最想要的是「重启服务把计数清零」，而重启本来就意味着他得先能碰到板子；
//   3. 进程重启后计数丢失 → 最坏情况是多给 5 次机会，可接受。
//
// 键 = 成员 id + 来源 IP：同一个 IP 试别人的账号、同一个账号被多个 IP 试，分别计数，
// 避免一个人输错密码把全家人一起锁住。

const MAX_FAILS = 5;              // 连续失败几次开始锁
const LOCK_MS = 5 * 60 * 1000;    // 锁多久
const SWEEP_AT = 2000;            // 表大到这个量级时顺手清一次过期的

/** @type {Map<string, {fails:number, until:number, at:number}>} */
const table = new Map();

/**
 * 造键。
 * @param {string} memberId 成员 id
 * @param {string} ip 来源 IP
 * @returns {string}
 */
function keyOf(memberId, ip) {
  return String(memberId || '') + '|' + String(ip || '');
}

/**
 * 清掉已经过期的记录，防止表无限长大。
 * 只在表比较大时才跑，正常家用永远触发不到。
 * @returns {void}
 */
function sweep() {
  if (table.size < SWEEP_AT) return;
  const now = Date.now();
  for (const [k, v] of table) {
    // 锁已过期、且最后一次失败也过去很久，这条记录就没有意义了
    if (v.until < now && now - v.at > LOCK_MS) table.delete(k);
  }
}

/**
 * 查这个键现在还能不能试。
 * @param {string} memberId 成员 id
 * @param {string} ip 来源 IP
 * @returns {{locked:boolean, retryAfterSec:number, left:number}} left = 还允许错几次
 */
function check(memberId, ip) {
  const key = keyOf(memberId, ip);
  const rec = table.get(key);
  if (!rec) return { locked: false, retryAfterSec: 0, left: MAX_FAILS };
  const now = Date.now();
  if (rec.until > now) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((rec.until - now) / 1000),
      left: 0
    };
  }
  // 锁过期了：计数从零开始，但记录留着（下次失败直接用）
  if (rec.until && rec.until <= now) {
    rec.fails = 0;
    rec.until = 0;
  }
  return { locked: false, retryAfterSec: 0, left: Math.max(0, MAX_FAILS - rec.fails) };
}

/**
 * 记一次失败。达到上限就上锁。
 * @param {string} memberId 成员 id
 * @param {string} ip 来源 IP
 * @returns {{locked:boolean, retryAfterSec:number, left:number}}
 */
function fail(memberId, ip) {
  const key = keyOf(memberId, ip);
  const now = Date.now();
  let rec = table.get(key);
  if (!rec) {
    rec = { fails: 0, until: 0, at: now };
    table.set(key, rec);
  }
  rec.fails += 1;
  rec.at = now;
  if (rec.fails >= MAX_FAILS) {
    rec.until = now + LOCK_MS;
    rec.fails = 0;
    sweep();
    return { locked: true, retryAfterSec: Math.ceil(LOCK_MS / 1000), left: 0 };
  }
  sweep();
  return { locked: false, retryAfterSec: 0, left: MAX_FAILS - rec.fails };
}

/**
 * 登录成功：把计数清掉，别让一次手滑影响后面。
 * @param {string} memberId 成员 id
 * @param {string} ip 来源 IP
 * @returns {void}
 */
function clear(memberId, ip) {
  table.delete(keyOf(memberId, ip));
}

/**
 * 测试用：重置全部状态。
 * @returns {void}
 */
function reset() {
  table.clear();
}

module.exports = { MAX_FAILS, LOCK_MS, check, fail, clear, reset };
