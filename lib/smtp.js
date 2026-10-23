'use strict';

// 手写 SMTP 客户端（零依赖，只用 net / tls）
//
// 为什么不用 nodemailer：它为了 10% 的复杂场景（附件、DKIM、模板、池化）多带 11 个包，
// 而我们只需要「把一段纯文本 + 一段 HTML 塞进一个收件箱」。200 行换零依赖，值。
//
// 只实现两个真实会用到的组合：
//   · 465  隐式 TLS（QQ / 163 推荐，也是唯一不用升级连接的方式）
//   · 587  STARTTLS（明文连接后升级）
// 25 端口在家里宽带上基本被封，不实现，也不给这个选项。

const net = require('net');
const tls = require('tls');

const TIMEOUT = 20000;

/**
 * 把一行按 RFC 2047 编码成 Base64 形式的头（中文主题必须这么干）。
 * @param {string} text 原文
 * @returns {string} 编码后的头
 */
function encodeHeader(text) {
  const s = String(text || '');
  // 纯 ASCII 直接用，省得一些老客户端对编码字处理不好
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

/**
 * 把地址列表整理成数组。
 * @param {string|string[]} to 收件人
 * @returns {string[]}
 */
function addrList(to) {
  if (Array.isArray(to)) return to.map((x) => String(x).trim()).filter(Boolean);
  return String(to || '').split(/[,;，；\s]+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 点填充：行首单独的 "." 要变成 ".."，否则会被当成正文结束符。
 * @param {string} body 正文
 * @returns {string} 处理后的正文
 */
function dotStuff(body) {
  return String(body).replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
}

/**
 * 组装 MIME 邮件正文。
 * @param {object} msg 邮件
 * @returns {string} 完整 DATA 段
 */
function buildMessage(msg) {
  const from = msg.from;
  const to = addrList(msg.to);
  const boundary = 'hb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')
    .replace(/(.{76})/g, '$1\r\n');

  const lines = [
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    'From: ' + from,
    'To: ' + to.join(', '),
    'Subject: ' + encodeHeader(msg.subject || ''),
    'Message-ID: <' + Date.now().toString(36) + '.' + Math.random().toString(36).slice(2) + '@homebox.local>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(msg.text || ''),
    '--' + boundary,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(msg.html || '<p>' + (msg.text || '') + '</p>'),
    '--' + boundary + '--',
    ''
  ];
  return dotStuff(lines.join('\r\n'));
}

/**
 * 一次 SMTP 会话。
 * @param {object} cfg 配置
 * @param {string} cfg.host 服务器
 * @param {number} cfg.port 端口
 * @param {boolean} cfg.secure 是否隐式 TLS
 * @param {string} [cfg.user] 账号（为空则跳过认证）
 * @param {string} [cfg.pass] 密码/授权码
 * @returns {Promise<object>} 会话对象 {read,write,end,upgrade}
 */
function connect(cfg) {
  return new Promise((resolve, reject) => {
    const options = { host: cfg.host, port: cfg.port, servername: cfg.host };
    const socket = cfg.secure
      ? tls.connect(options, () => resolve(makeSession(socket)))
      : net.connect(options, () => resolve(makeSession(socket)));
    socket.once('error', reject);
    socket.setTimeout(TIMEOUT, () => {
      socket.destroy(new Error('连接 SMTP 超时（' + cfg.host + ':' + cfg.port + '），检查网络或端口'));
    });
  });
}

/**
 * 把 socket 包成「按行读写」的会话。
 * @param {import('net').Socket} socket 连接
 * @returns {object} 会话
 */
function makeSession(socket) {
  let buffer = '';
  let waiter = null;
  const queue = [];

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf('\r\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      queue.push(line);
      idx = buffer.indexOf('\r\n');
    }
    if (waiter) waiter();
  });

  /**
   * 读一个「完整响应」：多行响应以 `ddd-` 续行，最后一行是 `ddd `。
   * @returns {Promise<{code:number, lines:string[]}>} 响应
   */
  function readReply() {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        if (!queue.length) {
          if (Date.now() - startedAt > TIMEOUT) {
            reject(new Error('等 SMTP 响应超时'));
            return;
          }
          waiter = () => { waiter = null; check(); };
          return;
        }
        const code = Number(String(queue[0]).slice(0, 3));
        const lines = [];
        while (queue.length) {
          const line = queue.shift();
          lines.push(line);
          if (line.charAt(3) !== '-') break;
        }
        resolve({ code, lines });
      };
      check();
    });
  }

  return {
    socket,
    readReply,
    /**
     * 发一行命令并读响应。
     * @param {string} line 命令
     * @returns {Promise<{code:number, lines:string[]}>}
     */
    async command(line) {
      socket.write(line + '\r\n');
      return readReply();
    },
    /**
     * 升级成 TLS（STARTTLS 用）。
     * @returns {Promise<void>}
     */
    upgrade() {
      return new Promise((resolve, reject) => {
        const secured = tls.connect({ socket, servername: socket.remoteAddress }, () => resolve());
        secured.once('error', reject);
        // 换了 socket，后续读写都走加密通道
        socket = secured;
        buffer = '';
        queue.length = 0;
        secured.setEncoding('utf8');
        secured.on('data', (chunk) => {
          buffer += chunk;
          let idx = buffer.indexOf('\r\n');
          while (idx !== -1) {
            queue.push(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 2);
            idx = buffer.indexOf('\r\n');
          }
          if (waiter) waiter();
        });
      });
    },
    end() {
      try { socket.end(); } catch (err) { /* 已断开 */ }
    }
  };
}

/**
 * 发一封邮件。
 * @param {object} cfg SMTP 配置（host/port/secure/user/pass）
 * @param {object} msg 邮件（from/to/subject/text/html）
 * @returns {Promise<{ok:boolean, code:number, detail:string}>}
 */
async function send(cfg, msg) {
  let session = null;
  try {
    session = await connect(cfg);

    const greeting = await session.readReply();
    if (greeting.code !== 220) {
      throw new Error('SMTP 没有正常打招呼：' + greeting.lines.join(' '));
    }

    let ehlo = await session.command('EHLO homebox.local');
    if (ehlo.code !== 250) throw new Error('EHLO 失败：' + ehlo.lines.join(' '));

    if (!cfg.secure) {
      const ready = await session.command('STARTTLS');
      if (ready.code !== 220) throw new Error('STARTTLS 被拒绝：' + ready.lines.join(' '));
      await session.upgrade();
      ehlo = await session.command('EHLO homebox.local');
      if (ehlo.code !== 250) throw new Error('TLS 升级后 EHLO 失败：' + ehlo.lines.join(' '));
    }

    if (cfg.user) {
      const auth = await session.command('AUTH LOGIN');
      if (auth.code !== 334) throw new Error('服务器不支持 AUTH LOGIN：' + auth.lines.join(' '));
      const u = await session.command(Buffer.from(cfg.user, 'utf8').toString('base64'));
      if (u.code !== 334) throw new Error('账号被拒：' + u.lines.join(' '));
      const p = await session.command(Buffer.from(String(cfg.pass || ''), 'utf8').toString('base64'));
      if (p.code !== 235) {
        throw new Error('授权码不对（QQ 邮箱要用「设置 → 账户 → 生成授权码」里的那串，不是登录密码）：' +
          p.lines.join(' '));
      }
    }

    const mailFrom = await session.command('MAIL FROM:<' + msg.from + '>');
    if (mailFrom.code !== 250) throw new Error('发件人被拒：' + mailFrom.lines.join(' '));

    const to = addrList(msg.to);
    for (const addr of to) {
      const rcpt = await session.command('RCPT TO:<' + addr + '>');
      if (rcpt.code !== 250 && rcpt.code !== 251) {
        throw new Error('收件人 ' + addr + ' 被拒：' + rcpt.lines.join(' '));
      }
    }

    const data = await session.command('DATA');
    if (data.code !== 354) throw new Error('DATA 被拒：' + data.lines.join(' '));

    session.socket.write(buildMessage(msg) + '\r\n.\r\n');
    const done = await session.readReply();
    if (done.code !== 250) throw new Error('邮件没有被接收：' + done.lines.join(' '));

    try { await session.command('QUIT'); } catch (err) { /* 服务器可能直接断开 */ }
    return { ok: true, code: done.code, detail: done.lines.join(' ') };
  } finally {
    if (session) session.end();
  }
}

module.exports = { send, encodeHeader, addrList, buildMessage, dotStuff };
