'use strict';

// HomeBox 家庭收纳服务端
// 零依赖：只使用 Node 内置模块，无需 npm install
//   node server.js                    本机预览 http://127.0.0.1:8080
//   HOST=0.0.0.0 node server.js       部署到香橙派，局域网内可访问
//   PORT=3000 node server.js          换个端口
//
// v2 P1：数据层从「单个 data/db.json 全量重写」换成 SQLite（Node 内置 node:sqlite）。
// 对外 API 的路径、方法、入参、返回结构、错误文案全部保持不变 —— 前端一个字节没改。
// 这个文件的职责只剩「HTTP 创建 + 路由分派 + 启动」，数据访问全在 lib/repo/ 里。

const httpMod = require('http');
const path = require('path');
const { URL } = require('url');

const web = require('./lib/http');
const photos = require('./lib/photos');
const boot = require('./lib/boot');
const db = require('./lib/db');
const locations = require('./lib/repo/locations');
const items = require('./lib/repo/items');
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

  if (pathname === '/api/locations') {
    if (req.method === 'GET') {
      return web.sendJSON(res, 200, {
        ok: true, tree: locations.buildTree(), settings: locations.loadSettings()
      });
    }
    if (req.method === 'POST') {
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
      // 连同子孙位置一起删除，其中的物品保留下来，只是标记为未归档
      // （items.loc_id 由外键 ON DELETE SET NULL 自动置空）
      const removed = db.tx(() => locations.removeMany(locations.collectSubtree(id)));
      return web.sendJSON(res, 200, { ok: true, removed });
    }
  }

  // 户型设置：家的真实宽度（米），只用于把抽象坐标换算成面积显示
  if (pathname === '/api/settings' && req.method === 'PUT') {
    const body = await web.readBody(req);
    const m = Number(body.planWidthM);
    if (!(m > 0) || m > 200) {
      return web.sendJSON(res, 400, { ok: false, error: '宽度要填一个正数（米）' });
    }
    return web.sendJSON(res, 200, { ok: true, settings: locations.savePlanWidthM(m) });
  }

  if (pathname === '/api/items') {
    if (req.method === 'GET') {
      const q = String(query.get('q') || '');
      return web.sendJSON(res, 200, { ok: true, items: items.list({ q }) });
    }
    if (req.method === 'POST') {
      const body = await web.readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return web.sendJSON(res, 400, { ok: false, error: '物品名称不能为空' });
      const item = items.create({
        name,
        locId: body.locId,
        note: body.note,
        qty: body.qty,
        tags: body.tags,
        wear: body.wear
      });
      return web.sendJSON(res, 201, { ok: true, item });
    }
  }

  /* ---------- 照片 ---------- */

  // 注意要排在 /api/items/:id 前面，否则 id 会被正则吃成 "xxx/photo"
  const photoMatch = pathname.match(/^\/api\/items\/(.+)\/photo$/);
  if (photoMatch) {
    const id = decodeURIComponent(photoMatch[1]);
    const item = items.get(id);
    if (!item) return web.sendJSON(res, 404, { ok: false, error: '物品不存在' });

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
      return web.sendJSON(res, 200, { ok: true, item: items.withPath(fresh), photo: saved });
    }

    if (req.method === 'DELETE') {
      const oldFile = item.photo || null;
      const fresh = items.clearPhoto(id);
      photos.deletePhotoFile(oldFile);
      return web.sendJSON(res, 200, { ok: true, item: items.withPath(fresh) });
    }
  }

  /* ---------- 衣柜模块 ---------- */

  // 记录「今天穿了」：累计次数、更新最近穿着日期，穿过的默认转为待洗
  const wearLog = pathname.match(/^\/api\/items\/(.+)\/wear$/);
  if (wearLog && req.method === 'POST') {
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
      ok: true, item: out.item, restored: out.restored
    });
  }

  if (pathname === '/api/wardrobe' && req.method === 'GET') {
    const list = items.listWear().map(items.withIdleDays);

    // facets：给前端的筛选 chips 提供每项的真实数量
    const facets = { types: {}, seasons: {}, colors: {}, status: {} };
    const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
    list.forEach((i) => {
      bump(facets.types, i.wear.type);
      (i.wear.seasons || []).forEach((s) => bump(facets.seasons, s));
      (i.wear.colors || []).forEach((c) => bump(facets.colors, c));
      bump(facets.status, i.wear.status);
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
    const pool = items.listWear().filter((i) => i.wear.status === 'ready'
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

    return web.sendJSON(res, 200, {
      ok: true, season, poolSize: pool.length, outfit, missing,
      dict: { types: util.WEAR_TYPES, status: util.WEAR_STATUS }
    });
  }

  // 已有数据库的补数据入口：往用户真实的衣柜结构里塞一批示例衣物
  if (pathname === '/api/wardrobe/demo' && req.method === 'POST') {
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
      const body = await web.readBody(req);
      const item = items.update(id, body);
      return web.sendJSON(res, 200, { ok: true, item });
    }

    if (req.method === 'DELETE') {
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
  console.log('');
});
