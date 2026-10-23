'use strict';

// HomeBox 家庭收纳服务端
// 零依赖：只使用 Node 内置模块，无需 npm install
//   node server.js                    本机预览 http://127.0.0.1:8080
//   HOST=0.0.0.0 node server.js       部署到香橙派，局域网内可访问
//   PORT=3000 node server.js          换个端口
//
// v2 P1：数据层换成 SQLite（Node 内置 node:sqlite），对外 API 行为不变。
// v2 P2：加上成员身份（四档角色）与物品金额/价值统计。金额在服务端按角色裁剪，
//        不做「前端隐藏」——前端隐藏挡不住直接调接口。
// 这个文件的职责仍是「HTTP 创建 + 路由分派 + 启动」，数据访问全在 lib/repo/ 里。

const httpMod = require('http');
const path = require('path');
const { URL } = require('url');

const web = require('./lib/http');
const photos = require('./lib/photos');
const boot = require('./lib/boot');
const db = require('./lib/db');
const auth = require('./lib/auth');
const roles = require('./lib/roles');
const locations = require('./lib/repo/locations');
const items = require('./lib/repo/items');
const members = require('./lib/repo/members');
const stats = require('./lib/repo/stats');
const reminders = require('./lib/repo/reminders');
const notifySettings = require('./lib/repo/settings');
const mailer = require('./lib/mailer');
const backup = require('./lib/backup');
const vision = require('./lib/vision');
const importer = require('./lib/importer');
const scheduler = require('./lib/scheduler');
const util = require('./lib/util');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const ROOT = __dirname;
// HB_DATA_DIR 只是给自动化测试用的钩子（冒烟测试要一份隔离的数据目录），
// 生产环境永远走默认的 data/，不改变任何对外行为。
const DATA_DIR = process.env.HB_DATA_DIR
  ? path.resolve(process.env.HB_DATA_DIR)
  : path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ---------- 启动 ---------- */

let runtime;
try {
  runtime = boot.boot({ dataDir: DATA_DIR, publicDir: PUBLIC_DIR });
  auth.configure({ dataDir: DATA_DIR });
} catch (err) {
  // 数据不可信就绝不出服务：宁可不启动，也不要让用户对着示例数据点一下
  // 把真实数据覆盖掉（这是旧版 readDB() 静默 seed 留下的最危险的那条路）。
  console.error('');
  console.error('[fatal] ' + (err.message || err));
  console.error('');
  process.exit(1);
}

if (runtime.migration) {
  const passed = runtime.migration.checks.filter((c) => c.ok).length;
  console.log('[info] 已从 data/db.json 迁移到 SQLite：位置 ' + runtime.migration.counts.locations +
    ' / 物品 ' + runtime.migration.counts.items + ' / 验收 ' + passed + '-' +
    runtime.migration.checks.length + ' 通过');
  console.log('[info] 备份： ' + runtime.migration.backup);
  // 迁移时被清洗过的数据必须让用户看见（数量被改是最容易被忽略的一类）
  (runtime.migration.warnings || []).forEach((w) => console.log('[提示] ' + w));
}
if (runtime.seeded && runtime.seeded.items) {
  console.log('[info] 首次启动，已写入示例数据：位置 ' + runtime.seeded.locations +
    ' / 物品 ' + runtime.seeded.items);
}
if (runtime.backfilled) {
  console.log('[info] 已为 ' + runtime.backfilled + ' 个位置补上地图坐标');
}

/* ---------- 身份与权限 ---------- */

/**
 * 解析当前请求的身份。没有任何成员时是「首次使用」状态，按管理员对待，
 * 既能建第一个管理员，也不会把老用户挡在门外。
 * @param {import('http').IncomingMessage} req 请求
 * @returns {object} 身份上下文
 */
function ctxOf(req) {
  return auth.context(req, { members, roles });
}

/**
 * 能力校验，不通过直接回 403 并返回 false。
 * @param {import('http').ServerResponse} res 响应
 * @param {object} ctx 身份上下文
 * @param {string} cap 能力名
 * @returns {boolean} 是否放行
 */
function guard(res, ctx, cap) {
  if (roles.can(ctx.role, cap)) return true;
  const label = (roles.ROLES.find((r) => r.k === ctx.role) || { n: '访客' }).n;
  web.sendJSON(res, 403, { ok: false, error: '当前身份（' + label + '）没有这个权限' });
  return false;
}

/**
 * 把元为单位的金额转成整数分。前端可以传 price（元）或 priceCents（分）。
 * @param {object} body 请求体
 * @returns {number|null|undefined} undefined 表示「没传，不要改」
 */
function priceArg(body) {
  if (body.priceCents !== undefined) return body.priceCents;
  if (body.price !== undefined) {
    if (body.price === null || body.price === '') return null;
    const n = Number(body.price);
    // 四舍五入到分：19.99 元 → 1999 分，避免浮点漂移
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }
  return undefined;
}

/* ---------- API ---------- */

/**
 * 处理所有 /api/* 请求。
 * @param {import('http').IncomingMessage} req 请求
 * @param {import('http').ServerResponse} res 响应
 * @param {string} pathname 已解码的路径
 * @param {URLSearchParams} query 查询串
 * @returns {Promise<void>}
 */
async function handleApi(req, res, pathname, query) {
  // 上传超限要在读请求体之前就判掉，否则白白收一大堆数据
  if ((req.method === 'POST' || req.method === 'PUT') && web.tooLarge(req, pathname)) {
    req.resume();
    const big = /\/photo$/.test(pathname);
    return web.sendJSON(res, 413, {
      ok: false, error: big
        ? '这张图太大了，重新拍一张小的，或者从相册里选压缩过的版本'
        : '提交的内容太长了'
    });
  }

  const ctx = ctxOf(req);
  // 会话临到期时静默续一次（无状态 Cookie 不需要写库）
  if (ctx.renew && ctx.member) auth.setSessionCookie(res, ctx.member, req);

  /* ---------- 身份 ---------- */

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    if (!ctx.bootstrap && ctx.member) members.touch(ctx.member.id);
    return web.sendJSON(res, 200, {
      ok: true,
      needSetup: ctx.needSetup,
      // 成员名单是「点头像登录」的前提，所以未登录也要能看到名字与角色。
      // 这里只给最小信息，绝不含密码哈希。
      members: members.list(),
      me: ctx.member ? {
        id: ctx.member.id, name: ctx.member.name, role: ctx.role
      } : null,
      caps: ctx.caps,
      roles: roles.ROLES,
      bootstrap: ctx.bootstrap
    });
  }

  if (pathname === '/api/auth/setup' && req.method === 'POST') {
    if (members.count() > 0) {
      return web.sendJSON(res, 409, { ok: false, error: '已经初始化过了' });
    }
    const body = await web.readBody(req);
    const out = members.create({
      name: body.name, role: 'admin', password: body.password
    });
    if (out.error) return web.sendJSON(res, out.error.status, { ok: false, error: out.error.error });
    auth.setSessionCookie(res, { id: out.member.id, role: out.member.role, passVer: 0 }, req);
    return web.sendJSON(res, 201, {
      ok: true, member: out.member, recoverCode: out.recoverCode || null
    });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await web.readBody(req);
    const id = String(body.memberId || body.id || '');
    const row = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!row) return web.sendJSON(res, 404, { ok: false, error: '没有这个人' });

    if (row.pass_hash) {
      // 设过密码的成员必须验密码
      const checked = members.checkPassword(id, body.password);
      if (!checked.ok) return web.sendJSON(res, 401, { ok: false, error: '密码不对' });
    }
    const member = members.getAuth(id);
    members.touch(id);
    auth.setSessionCookie(res, member, req);
    return web.sendJSON(res, 200, {
      ok: true, me: { id: member.id, name: member.name, role: member.role },
      caps: roles.capsOf(member.role)
    });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    auth.clearSessionCookie(res);
    return web.sendJSON(res, 200, { ok: true });
  }

  /* ---------- 成员管理 ---------- */

  if (pathname === '/api/members') {
    if (!guard(res, ctx, 'members')) return;
    if (req.method === 'GET') return web.sendJSON(res, 200, { ok: true, members: members.list() });
    if (req.method === 'POST') {
      const body = await web.readBody(req);
      const out = members.create({ name: body.name, role: body.role, password: body.password });
      if (out.error) return web.sendJSON(res, out.error.status, { ok: false, error: out.error.error });
      return web.sendJSON(res, 201, { ok: true, member: out.member, recoverCode: out.recoverCode || null });
    }
  }

  const memberMatch = pathname.match(/^\/api\/members\/([^/]+)(\/password)?$/);
  if (memberMatch) {
    if (!guard(res, ctx, 'members')) return;
    const id = decodeURIComponent(memberMatch[1]);
    const isPassword = !!memberMatch[2];

    if (isPassword && req.method === 'POST') {
      const body = await web.readBody(req);
      const out = members.setPassword(id, body.password);
      if (out.error) return web.sendJSON(res, out.error.status, { ok: false, error: out.error.error });
      return web.sendJSON(res, 200, {
        ok: true, member: out.member, recoverCode: out.recoverCode || null
      });
    }
    if (req.method === 'PUT') {
      const body = await web.readBody(req);
      const out = members.update(id, { name: body.name, role: body.role });
      if (out.error) return web.sendJSON(res, out.error.status, { ok: false, error: out.error.error });
      return web.sendJSON(res, 200, { ok: true, member: out.member });
    }
    if (req.method === 'DELETE') {
      const out = members.remove(id);
      if (out.error) return web.sendJSON(res, out.error.status, { ok: false, error: out.error.error });
      return web.sendJSON(res, 200, { ok: true });
    }
  }

  /* ---------- 价值统计 ---------- */

  if (pathname === '/api/stats/value' && req.method === 'GET') {
    if (!guard(res, ctx, 'stats')) return;
    const by = String(query.get('by') || 'loc');
    return web.sendJSON(res, 200, Object.assign({ ok: true }, stats.value({ by })));
  }

  /* ---------- 提醒 ---------- */

  if (pathname === '/api/reminders' && req.method === 'GET') {
    const out = reminders.compute();
    return web.sendJSON(res, 200, {
      ok: true,
      today: out.today,
      counts: out.counts,
      groups: out.groups,
      kinds: notifySettings.raw().kinds,
      labels: mailer.KIND_LABEL
    });
  }

  const ackMatch = pathname.match(/^\/api\/reminders\/([^/]+)\/([^/]+)\/ack$/);
  if (ackMatch && req.method === 'POST') {
    if (!guard(res, ctx, 'write')) return;
    const body = await web.readBody(req);
    const out = reminders.ack(decodeURIComponent(ackMatch[1]),
      decodeURIComponent(ackMatch[2]), String(body.action || 'done'));
    if (out.error) return web.sendJSON(res, out.error.status, { ok: false, error: out.error.error });
    return web.sendJSON(res, 200, { ok: true });
  }

  /* ---------- 通知设置与运维 ---------- */

  if (pathname === '/api/notify/settings') {
    if (!guard(res, ctx, 'settings')) return;
    if (req.method === 'GET') {
      return web.sendJSON(res, 200, { ok: true, settings: notifySettings.publicView() });
    }
    if (req.method === 'PUT') {
      const body = await web.readBody(req);
      const out = notifySettings.save(body);
      if (out.error) return web.sendJSON(res, out.error.status, { ok: false, error: out.error.error });
      return web.sendJSON(res, 200, { ok: true, settings: out.settings });
    }
  }

  // 发测试邮件：同步等 SMTP 结果，把原始错误直接回给用户
  if (pathname === '/api/notify/test' && req.method === 'POST') {
    if (!guard(res, ctx, 'settings')) return;
    const out = await mailer.sendNow({
      subject: 'HomeBox 测试邮件',
      text: '收到这封说明配置成功了。以后每天会把快过期、快用完、借出未还的东西汇总成一封发到这里。',
      html: '<div style="font-family:-apple-system,sans-serif;padding:20px;background:#f7f4ee;' +
        'border-radius:12px;color:#3c2f22"><h3 style="margin:0 0 8px">配置成功了</h3>' +
        '<p style="margin:0;color:#8a7a66;font-size:13px">以后每天会把快过期、快用完、' +
        '借出未还的东西汇总成一封发到这里。</p></div>'
    });
    if (!out.ok) return web.sendJSON(res, 400, { ok: false, error: out.error });
    return web.sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/jobs/status' && req.method === 'GET') {
    if (!guard(res, ctx, 'settings')) return;
    return web.sendJSON(res, 200, Object.assign({ ok: true }, scheduler.status()));
  }

  if (pathname === '/api/jobs/run' && req.method === 'POST') {
    if (!guard(res, ctx, 'settings')) return;
    const body = await web.readBody(req);
    const job = String(body.job || 'daily');
    const out = await scheduler.runNow(job);
    return web.sendJSON(res, out.ok ? 200 : 400, { ok: out.ok, detail: out.detail });
  }

  if (pathname === '/api/backup/status' && req.method === 'GET') {
    if (!guard(res, ctx, 'settings')) return;
    return web.sendJSON(res, 200, { ok: true, backup: backup.status(DATA_DIR) });
  }

  if (pathname === '/api/backup/run' && req.method === 'POST') {
    if (!guard(res, ctx, 'settings')) return;
    const out = backup.run({ dataDir: DATA_DIR, reason: 'manual' });
    return web.sendJSON(res, 200, {
      ok: true,
      backup: out,
      status: backup.status(DATA_DIR)
    });
  }

  // 检测备份目录能不能写（设置页那个按钮）
  if (pathname === '/api/backup/probe' && req.method === 'POST') {
    if (!guard(res, ctx, 'settings')) return;
    const body = await web.readBody(req);
    const dir = String(body.dir || '').trim();
    return web.sendJSON(res, 200, Object.assign({ ok: true }, backup.probeDir(dir)));
  }

  /* ---------- 拍照识别 ---------- */

  // 任何身份都能问「能不能识别」：前端据此决定渲不渲染拍照按钮。
  // 没启用时不是「点了报错」，而是按钮根本不存在。
  if (pathname === '/api/ai/status' && req.method === 'GET') {
    const cfg = notifySettings.raw().ai;
    return web.sendJSON(res, 200, {
      ok: true,
      available: notifySettings.aiReady() && roles.can(ctx.role, 'write'),
      enabled: !!cfg.enabled,
      model: cfg.model,
      preset: cfg.preset
    });
  }

  if (pathname === '/api/vision/recognize' && req.method === 'POST') {
    if (!notifySettings.aiReady()) {
      return web.sendJSON(res, 404, { ok: false, error: '没有启用拍照识别' });
    }
    if (!guard(res, ctx, 'write')) return;
    const body = await web.readBody(req, web.MAX_PHOTO_BODY);
    const out = await vision.recognize(body.image || body.data, notifySettings.raw().ai);
    if (!out.ok && out.error) {
      return web.sendJSON(res, 400, { ok: false, error: out.error });
    }
    // 失败也是 200：前端只显示一行灰字，绝不打断录入
    return web.sendJSON(res, 200, out);
  }

  /* ---------- 导出 / 回灌 ---------- */

  if (pathname === '/api/export' && req.method === 'GET') {
    if (!guard(res, ctx, 'settings')) return;
    const doc = backup.buildDocument();
    const body = JSON.stringify(doc, null, 2);
    const name = 'homebox-' + reminders.localDate().replace(/-/g, '') + '.json';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'Cache-Control': 'no-store'
    });
    return res.end(body);
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    if (!guard(res, ctx, 'settings')) return;
    const body = await web.readBody(req, web.MAX_PHOTO_BODY);
    // 破坏性操作：必须显式带 confirm，防止前端误调用
    if (body.confirm !== 'REPLACE') {
      return web.sendJSON(res, 400, {
        ok: false, error: '回灌会整体替换现有数据，需要在请求里带上 confirm="REPLACE"'
      });
    }
    const out = importer.importAll(body.document || body, { dataDir: DATA_DIR });
    if (out.error) {
      return web.sendJSON(res, out.error.status, {
        ok: false, error: out.error.error, backupFile: out.backupFile || null
      });
    }
    return web.sendJSON(res, 200, {
      ok: true, counts: out.counts, backupFile: out.backupFile
    });
  }

  /* ---------- 位置 ---------- */

  if (pathname === '/api/locations') {
    if (req.method === 'GET') {
      const tree = roles.forTree(stats.decorateTree(locations.buildTree()), ctx.role);
      return web.sendJSON(res, 200, {
        ok: true, tree, settings: locations.loadSettings()
      });
    }
    if (req.method === 'POST') {
      if (!guard(res, ctx, 'write')) return;
      const body = await web.readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return web.sendJSON(res, 400, { ok: false, error: '位置名称不能为空' });
      const kind = locations.KINDS.indexOf(body.kind) !== -1
        ? body.kind
        : (body.parent ? 'compartment' : 'home');
      // 新建就给一个可见的位置，免得用户以为没建成
      let box = locations.normalizeBox(body.box);
      if (!box) {
        if (kind === 'room') box = locations.autoRoomBox();
        else if (kind === 'furniture') box = locations.autoFurnitureBox(body.parent || null);
      }
      const location = locations.create({ name, kind, parent: body.parent || null, box });
      return web.sendJSON(res, 201, { ok: true, location });
    }
  }

  if (pathname.startsWith('/api/locations/')) {
    const id = decodeURIComponent(pathname.slice('/api/locations/'.length));
    const cur = locations.get(id);
    if (!cur) return web.sendJSON(res, 404, { ok: false, error: '位置不存在' });

    if (req.method === 'PUT') {
      if (!guard(res, ctx, 'write')) return;
      const body = await web.readBody(req);
      const patch = {};
      if (body.name !== undefined) patch.name = String(body.name).trim() || cur.name;
      if (body.box !== undefined) patch.box = body.box;
      if (body.parent !== undefined) {
        const next = body.parent || null;
        if (next === cur.id) {
          return web.sendJSON(res, 400, { ok: false, error: '不能挂到自己下面' });
        }
        // 把自己的某个上级挪到自己下面会让整棵树断掉
        if (next && locations.isDescendant(cur.id, next)) {
          return web.sendJSON(res, 400, { ok: false, error: '不能挂到自己的下级里' });
        }
        if (next && !locations.get(next)) {
          return web.sendJSON(res, 404, { ok: false, error: '上级位置不存在' });
        }
        patch.parent = next;
      }
      if (body.kind !== undefined && locations.KINDS.indexOf(body.kind) !== -1) {
        patch.kind = body.kind;
      }
      const location = locations.update(id, patch);
      return web.sendJSON(res, 200, { ok: true, location });
    }

    if (req.method === 'DELETE') {
      if (!guard(res, ctx, 'remove')) return;
      // P2：禁止删除「家」这一层。调一次就能抹掉整个户型和所有归位信息，
      // 代价远大于收益，而且前端本来也点不到它（它没有地图坐标）。
      if (cur.kind === 'home') {
        return web.sendJSON(res, 400, { ok: false, error: '「家」这一层不能删除' });
      }
      // 连同子孙位置一起删除，其中的物品保留下来，只是标记为未归档
      // （items.loc_id 由外键 ON DELETE SET NULL 自动置空）
      const removed = db.tx(() => locations.removeMany(locations.collectSubtree(id)));
      return web.sendJSON(res, 200, { ok: true, removed });
    }
  }

  // 户型设置：家的真实宽度（米），只用于把抽象坐标换算成面积显示
  if (pathname === '/api/settings' && req.method === 'PUT') {
    if (!guard(res, ctx, 'settings')) return;
    const body = await web.readBody(req);
    const m = Number(body.planWidthM);
    if (!(m > 0) || m > 200) {
      return web.sendJSON(res, 400, { ok: false, error: '宽度要填一个正数（米）' });
    }
    return web.sendJSON(res, 200, { ok: true, settings: locations.savePlanWidthM(m) });
  }

  /* ---------- 物品 ---------- */

  if (pathname === '/api/items') {
    if (req.method === 'GET') {
      const q = String(query.get('q') || '');
      const opts = { q };
      if (query.has('ownerId')) opts.ownerId = String(query.get('ownerId'));
      if (query.has('category')) opts.category = String(query.get('category'));
      if (query.has('state')) opts.state = String(query.get('state'));
      const list = items.list(opts).map((i) => roles.forItem(i, ctx.role));
      return web.sendJSON(res, 200, { ok: true, items: list });
    }
    if (req.method === 'POST') {
      if (!guard(res, ctx, 'write')) return;
      const body = await web.readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return web.sendJSON(res, 400, { ok: false, error: '物品名称不能为空' });
      const item = items.create({
        name,
        locId: body.locId,
        note: body.note,
        qty: body.qty,
        tags: body.tags,
        wear: body.wear,
        category: body.category,
        priceCents: priceArg(body),
        buyDate: body.buyDate,
        expireAt: body.expireAt,
        remindDays: body.remindDays,
        minQty: body.minQty,
        lendTo: body.lendTo,
        // 没指定归属就记在当前登录人头上（首次使用状态下没有真实成员，留空）
        ownerId: body.ownerId !== undefined ? body.ownerId
          : (ctx.bootstrap ? null : ctx.member.id)
      });
      return web.sendJSON(res, 201, { ok: true, item: roles.forItem(item, ctx.role) });
    }
  }

  /* ---------- 照片 ---------- */

  // 注意要排在 /api/items/:id 前面，否则 id 会被正则吃成 "xxx/photo"
  const photoMatch = pathname.match(/^\/api\/items\/(.+)\/photo$/);
  if (photoMatch) {
    const id = decodeURIComponent(photoMatch[1]);
    const item = items.get(id);
    if (!item) return web.sendJSON(res, 404, { ok: false, error: '物品不存在' });
    if (!guard(res, ctx, 'write')) return;

    if (req.method === 'POST') {
      const body = await web.readBody(req, web.MAX_PHOTO_BODY);
      let saved;
      try {
        saved = photos.writePhotoFile(body.data);
      } catch (err) {
        return web.sendJSON(res, 400, { ok: false, error: err.message });
      }
      // 换新照片就把旧的删掉，别让 TF 卡白占地方
      const oldFile = item.photo || null;
      const fresh = items.setPhoto(id, saved.file);
      if (oldFile && oldFile !== saved.file) photos.deletePhotoFile(oldFile);
      return web.sendJSON(res, 200, {
        ok: true, item: roles.forItem(items.withPath(fresh), ctx.role), photo: saved
      });
    }

    if (req.method === 'DELETE') {
      const oldFile = item.photo || null;
      const fresh = items.clearPhoto(id);
      photos.deletePhotoFile(oldFile);
      return web.sendJSON(res, 200, { ok: true, item: roles.forItem(items.withPath(fresh), ctx.role) });
    }
  }

  /* ---------- 衣柜模块 ---------- */

  // 记录「今天穿了」：累计次数、更新最近穿着日期，穿过的默认转为待洗
  const wearLog = pathname.match(/^\/api\/items\/(.+)\/wear$/);
  if (wearLog && req.method === 'POST') {
    if (!guard(res, ctx, 'write')) return;
    const id = decodeURIComponent(wearLog[1]);
    const cur = items.get(id);
    if (!cur) return web.sendJSON(res, 404, { ok: false, error: '找不到这件东西' });
    if (!cur.wear) return web.sendJSON(res, 400, { ok: false, error: '它不是衣服' });
    const body = await web.readBody(req);
    const out = items.logWear(id, { undo: !!body.undo, laundry: body.laundry !== false });
    if (out.error) {
      return web.sendJSON(res, out.error.status, { ok: false, error: out.error.error });
    }
    return web.sendJSON(res, 200, {
      ok: true, item: roles.forItem(out.item, ctx.role), restored: out.restored
    });
  }

  if (pathname === '/api/wardrobe' && req.method === 'GET') {
    const list = items.listWear().map(items.withIdleDays)
      .map((i) => roles.forItem(i, ctx.role));

    // facets：给前端的筛选 chips 提供每项的真实数量
    const facets = { types: {}, seasons: {}, colors: {}, status: {}, owners: {} };
    const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
    list.forEach((i) => {
      bump(facets.types, i.wear.type);
      (i.wear.seasons || []).forEach((s) => bump(facets.seasons, s));
      (i.wear.colors || []).forEach((c) => bump(facets.colors, c));
      bump(facets.status, i.wear.status);
      bump(facets.owners, i.ownerId || '');
    });

    const month = new Date().getMonth() + 1;
    return web.sendJSON(res, 200, {
      ok: true, items: list, facets, month, season: util.seasonOfMonth(month),
      dict: { types: util.WEAR_TYPES, seasons: util.WEAR_SEASONS, status: util.WEAR_STATUS }
    });
  }

  if (pathname === '/api/wardrobe/suggest' && req.method === 'GET') {
    const thisSeason = util.seasonOfMonth(new Date().getMonth() + 1);
    const season = util.validOf(util.WEAR_SEASONS, query.get('season'), thisSeason);
    // 只从「可穿」且适合当季的里面挑
    const owner = query.get('ownerId');
    const pool = items.listWear().filter((i) => i.wear.status === 'ready'
      && (!owner || i.ownerId === owner)
      && (!i.wear.seasons.length || i.wear.seasons.indexOf(season) !== -1));

    // 少穿的优先：随机取前 60%，长期压箱底的衣服才有机会被翻出来
    const pick = (types) => {
      const arr = pool.filter((i) => types.indexOf(i.wear.type) !== -1);
      if (!arr.length) return null;
      const sorted = arr.slice().sort((a, b) => (a.wear.wearCount || 0) - (b.wear.wearCount || 0));
      const head = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.6)));
      return head[Math.floor(Math.random() * head.length)];
    };

    const dress = pick(['dress']);
    const outfit = {
      top: dress ? null : pick(['top']),
      bottom: dress ? null : pick(['bottom']),
      dress,
      outer: pick(['outer']),
      shoes: pick(['shoes']),
      accessory: pick(['accessory'])
    };
    const missing = Object.keys(outfit).filter((k) => !outfit[k] && k !== 'accessory');
    const strip = (x) => (x ? roles.forItem(x, ctx.role) : null);

    return web.sendJSON(res, 200, {
      ok: true, season, poolSize: pool.length,
      outfit: {
        top: strip(outfit.top), bottom: strip(outfit.bottom), dress: strip(outfit.dress),
        outer: strip(outfit.outer), shoes: strip(outfit.shoes), accessory: strip(outfit.accessory)
      },
      missing,
      dict: { types: util.WEAR_TYPES, status: util.WEAR_STATUS }
    });
  }

  // 已有数据库的补数据入口：往用户真实的衣柜结构里塞一批示例衣物
  if (pathname === '/api/wardrobe/demo' && req.method === 'POST') {
    if (!guard(res, ctx, 'write')) return;
    const out = items.importDemoWear();
    if (out.error) {
      return web.sendJSON(res, out.error.status, { ok: false, error: out.error.error });
    }
    return web.sendJSON(res, 201, { ok: true, added: out.added, wardrobe: out.wardrobe });
  }

  const itemMatch = pathname.match(/^\/api\/items\/(.+)$/);
  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);
    const cur = items.get(id);
    if (!cur) return web.sendJSON(res, 404, { ok: false, error: '物品不存在' });

    if (req.method === 'PUT') {
      if (!guard(res, ctx, 'write')) return;
      const body = await web.readBody(req);
      const patch = Object.assign({}, body);
      const cents = priceArg(body);
      if (cents !== undefined) patch.priceCents = cents;
      const item = items.update(id, patch);
      return web.sendJSON(res, 200, { ok: true, item: roles.forItem(item, ctx.role) });
    }

    if (req.method === 'DELETE') {
      if (!guard(res, ctx, 'remove')) return;
      const gone = items.remove(id);
      // 东西删了，它的照片也就没用了
      if (gone && gone.photo) photos.deletePhotoFile(gone.photo);
      return web.sendJSON(res, 200, { ok: true });
    }
  }

  return web.sendJSON(res, 404, { ok: false, error: '接口不存在' });
}

/* ---------- HTTP ---------- */

const server = httpMod.createServer((req, res) => {
  let parsed;
  try {
    parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400');
  }

  if (pathname.startsWith('/photos/')) {
    return photos.servePhoto(res, pathname);
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.searchParams).catch((err) => {
      console.error('[api error]', err);
      if (!res.headersSent) {
        web.sendJSON(res, err.statusCode || 500, { ok: false, error: err.message || '服务端错误' });
      }
    });
    return;
  }
  web.serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  HomeBox 已启动');
  console.log('  本机访问： http://127.0.0.1:' + PORT);
  if (HOST !== '0.0.0.0') {
    console.log('  想在手机上试这个命令重启： HOST=0.0.0.0 node server.js');
  }
  console.log('  数据文件： ' + runtime.dbFile);
  console.log('  运行环境： Node ' + runtime.info.node.replace(/^v/, '') +
    ' · SQLite ' + runtime.info.sqlite + ' · schema v' + runtime.info.schemaVersion);
  if (members.count() === 0) {
    console.log('  首次使用：打开页面先创建管理员（也可以先不建，本机全权限）');
  }
  // 定时任务：每日摘要 + 每日备份。启动即补一次（断电错过的窗口在这里补）
  scheduler.start({ dataDir: DATA_DIR });
  console.log('  定时任务：备份 03:00 · 邮件 ' + notifySettings.raw().mail.time +
    (notifySettings.mailReady() ? '' : '（邮件未配置，只做站内提醒）'));
  console.log('');
});
