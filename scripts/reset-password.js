#!/usr/bin/env node
'use strict';

// 忘记密码时的兜底：在跑着服务的那台机器上直接改。
//
//   node scripts/reset-password.js 老王                  → 生成一个随机密码并打印
//   node scripts/reset-password.js 老王 --password 新密码  → 用你指定的密码
//   node scripts/reset-password.js --list                → 先看看都有谁
//
// 为什么不做「邮箱找回」：这个服务故意不依赖任何外部发信能力，
// 邮箱找回会把「忘记密码」变成「先配好 SMTP」，对家庭场景是净负担。
// 能物理接触到这台机器的人，本来就有权改数据。

const path = require('path');
const crypto = require('crypto');

const boot = require('../lib/boot');
const db = require('../lib/db');
const auth = require('../lib/auth');
const members = require('../lib/repo/members');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.HB_DATA_DIR
  ? path.resolve(process.env.HB_DATA_DIR)
  : path.join(ROOT, 'data');

/**
 * 解析命令行。
 * @param {string[]} argv 参数
 * @returns {{who:string, password:string|null, list:boolean}}
 */
function parseArgs(argv) {
  const out = { who: '', password: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--list') out.list = true;
    else if (argv[i] === '--password' && argv[i + 1]) {
      out.password = argv[i + 1];
      i += 1;
    } else if (!out.who && argv[i].indexOf('--') !== 0) {
      out.who = argv[i];
    }
  }
  return out;
}

/**
 * 生成好念一点的随机密码（去掉容易看错的 0/O/1/l/I）。
 * @param {number} [len] 长度
 * @returns {string}
 */
function randomPassword(len) {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(len || 10);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    boot.boot({ dataDir: DATA_DIR, publicDir: path.join(ROOT, 'public') });
    auth.configure({ dataDir: DATA_DIR });
  } catch (err) {
    console.error('[fatal] 打不开数据库：' + (err.message || err));
    process.exit(1);
  }

  const all = members.list();
  if (!all.length) {
    console.error('还没有任何成员。打开一次页面就能创建管理员。');
    process.exit(1);
  }

  if (args.list || !args.who) {
    console.log('');
    console.log('  现有成员：');
    all.forEach((m) => {
      console.log('   · ' + m.name + '（' + m.role + (m.hasPassword ? '，有密码' : '，点头像进') + '）');
    });
    console.log('');
    console.log('  用法：node scripts/reset-password.js <名字> [--password 新密码]');
    console.log('');
    process.exit(args.list ? 0 : 1);
  }

  // 名字或 id 都认，省得去翻数据库
  const target = all.find((m) => m.name === args.who || m.id === args.who);
  if (!target) {
    console.error('没找到叫「' + args.who + '」的成员。先跑一次 --list 看看。');
    process.exit(1);
  }

  const password = args.password || randomPassword(10);
  if (password.length < 6) {
    console.error('密码至少 6 位。');
    process.exit(1);
  }

  const out = members.setPassword(target.id, password);
  if (out.error) {
    console.error('[fatal] ' + out.error.error);
    process.exit(1);
  }

  console.log('');
  console.log('  已重设密码：' + target.name);
  console.log('  新密码：' + password);
  if (!args.password) {
    console.log('  （随机生成的，只显示这一次，记下来）');
  }
  if (out.recoverCode) {
    console.log('  恢复码：' + out.recoverCode + '（抄在路由器背面）');
  }
  console.log('  该成员在所有设备上的登录已失效，需要用新密码重新登录。');
  console.log('');
}

main();
