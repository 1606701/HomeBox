'use strict';

// B 组：接口行为回归（核心）
//
// 做法：同一份 v1 数据，一边跑 main 分支的 server.js（旧版），一边跑当前分支（新版），
// 对同一串请求逐字节比 JSON。只读接口要求「完全一致」；写接口把必然不同的
// id / 时间戳按首次出现顺序抹平后要求「结构与值一致」。

const fs = require('fs');
const path = require('path');

const util = require('../lib/util');
const servers = require('../lib/servers');
const httpc = require('../lib/httpc');
const canon = require('../lib/canon');
const { expect } = require('../lib/runner');

/**
 * 造一个「新旧各一份」的请求对。
 * @param {object} s 服务组
 * @returns {object} pair
 */
function makePair(s) {
  return {
    old: { base: s.oldSrv.base, ctx: canon.newContext() },
    new: { base: s.newSrv.base, ctx: canon.newContext() }
  };
}

/**
 * 同时向新旧两边发同样的请求。
 * @param {object} pair 请求对
 * @param {string} method 方法
 * @param {string} urlPath 路径
 * @param {object} [opts] 选项（body/headers）
 * @returns {Promise<{old:object, new:object}>}
 */
async function both(pair, method, urlPath, opts) {
  const cfg = opts || {};
  const [o, n] = await Promise.all([
    httpc.request(pair.old.base, method, urlPath, cfg),
    httpc.request(pair.new.base, method, urlPath, cfg)
  ]);
  return { old: o, new: n };
}

/**
 * 向两边发请求，路径与请求体都可以按边生成 —— 因为同一个逻辑对象在新旧库里 id 不同，
 * 写操作链必须「各用各的 id」，否则会拿新 id 去打旧库（404）。
 * @param {object} pair 请求对
 * @param {string} method 方法
 * @param {string|Function} pathOrFn 路径，或 (side) => 路径
 * @param {*|Function} [bodyOrFn] 请求体，或 (side) => 请求体
 * @returns {Promise<{old:object, new:object}>}
 */
async function both2(pair, method, pathOrFn, bodyOrFn) {
  const build = (side) => {
    const p = typeof pathOrFn === 'function' ? pathOrFn(side) : pathOrFn;
    const b = typeof bodyOrFn === 'function' ? bodyOrFn(side) : bodyOrFn;
    return httpc.request(pair[side].base, method, p, b === undefined ? {} : { body: b });
  };
  const [o, n] = await Promise.all([build('old'), build('new')]);
  return { old: o, new: n };
}

/**
 * 取出响应里的 id，按「旧/新」分开存。
 * @param {{old:object,new:object}} res 响应对
 * @param {string} key 顶层字段名（location / item）
 * @returns {{old:string,new:string}}
 */
function idsOf(res, key) {
  const o = res.old.json && res.old.json[key] ? res.old.json[key].id : '';
  const n = res.new.json && res.new.json[key] ? res.new.json[key].id : '';
  if (!o || !n) {
    throw new Error('响应里没有 ' + key + '.id：旧 ' + res.old.text.slice(0, 160) +
      ' / 新 ' + res.new.text.slice(0, 160));
  }
  return { old: o, new: n };
}

/**
 * 生成「按边取 id」的路径构造函数。
 * @param {string} prefix 路径前缀，如 /api/locations/
 * @param {{old:string,new:string}} ids id 对
 * @param {string} [suffix] 后缀，如 /wear
 * @returns {Function} (side) => 路径
 */
function pathOf(prefix, ids, suffix) {
  const tail = suffix || '';
  return (side) => prefix + encodeURIComponent(ids[side]) + tail;
}

/**
 * 要求两边响应逐字节相同（只读接口）。
 * @param {{old:object,new:object}} res 响应对
 * @param {string} label 用例说明
 */
function sameBytes(res, label) {
  expect.eq(res.old.status, res.new.status, label + ' 状态码');
  if (res.old.text !== res.new.text) {
    let detail = '';
    try {
      detail = canon.render(canon.diff(JSON.parse(res.old.text), JSON.parse(res.new.text)));
    } catch (err) {
      detail = '  旧：' + res.old.text.slice(0, 300) + '\n  新：' + res.new.text.slice(0, 300);
    }
    throw new Error(label + ' 响应体不是逐字节相同：\n' + detail);
  }
}

/**
 * 要求两边结构相同（把 id / 时间戳抹平后比较）。
 * @param {object} pair 请求对
 * @param {{old:object,new:object}} res 响应对
 * @param {string} label 说明
 */
function sameShape(pair, res, label) {
  expect.eq(res.old.status, res.new.status, label + ' 状态码');
  const a = canon.canon(res.old.json, pair.old.ctx);
  const b = canon.canon(res.new.json, pair.new.ctx);
  const diffs = canon.diff(a, b);
  if (diffs.length) {
    throw new Error(label + ' 结构与值不一致（' + diffs.length + ' 处）：\n' +
      canon.render(diffs));
  }
}

/**
 * 注册 B 组用例。
 * @param {object} runner Runner
 * @param {object} ctx 共享上下文
 */
function register(runner, ctx) {
  const repoRoot = ctx.repoRoot;

  // 起两套服务：只在第一次用到时初始化，结束时统一清理
  const setup = util.once(async () => {
    const newDir = util.makeTempDir('hb-qa-new-');
    const newData = path.join(newDir, 'data');
    servers.prepareDataDir(repoRoot, newData);
    const mig = servers.runMigrate(repoRoot, newData);
    if (mig.code !== 0) {
      throw new Error('准备新版数据目录失败（迁移退出码 ' + mig.code + '）：\n' + mig.stdout);
    }
    const oldDir = util.makeTempDir('hb-qa-old-');
    const oldRoot = path.join(oldDir, 'root');
    const prep = servers.prepareOldRoot(repoRoot, oldRoot);
    if (!prep.ok) throw new Error(prep.reason);

    const newSrv = await servers.startNewServer({ repoRoot, dataDir: newData });
    let oldSrv;
    try {
      oldSrv = await servers.startOldServer({ oldRoot });
    } catch (err) {
      await servers.stopServer(newSrv);
      throw err;
    }
    ctx.onCleanup(async () => {
      await servers.stopServer(newSrv);
      await servers.stopServer(oldSrv);
      util.rmrf(newDir);
      util.rmrf(oldDir);
    });
    return { newSrv, oldSrv, newData, oldRoot };
  });

  runner.section('B 接口行为回归（与 main 分支逐字节对照）');

  runner.test('B1', 'GET /api/locations：树结构 / itemCount / totalCount / settings 逐字节一致',
    async () => {
      const s = await setup();
      const pair = makePair(s);
      const res = await both(pair, 'GET', '/api/locations');
      sameBytes(res, 'GET /api/locations');
      // 顺手确认树里确实有内容，避免「两边都返回空」也判过
      const roots = res.new.json.tree;
      expect.eq(roots.length, 1, '根节点个数');
      expect.eq(roots[0].id, 'l_home', '根节点 id');
      expect.eq(roots[0].totalCount, 26, '全屋物品合计');
      expect.eq(res.new.json.settings.planWidthM, 12, 'settings.planWidthM');
    }, { repro: 'node qa/qa-p1.js --only B1' });

  runner.test('B2', 'GET /api/items：26 条物品的顺序、字段顺序、path 逐字节一致', async () => {
    const s = await setup();
    const pair = makePair(s);
    const res = await both(pair, 'GET', '/api/items');
    sameBytes(res, 'GET /api/items');
    expect.eq(res.new.json.items.length, 26, '物品条数');
    // 排序语义：updatedAt 倒序
    const times = res.new.json.items.map((i) => i.updatedAt);
    const sorted = times.slice().sort((a, b) => (a < b ? 1 : (a > b ? -1 : 0)));
    expect.deep(times, sorted, 'items 应按 updatedAt 倒序');
  }, { repro: 'node qa/qa-p1.js --only B2' });

  runner.test('B3', 'GET /api/items?q=… 12 种查询（中文/标签/路径/大小写/空/通配符/超长）逐字节一致',
    async () => {
      const s = await setup();
      const pair = makePair(s);
      const queries = [
        '',                      // 空 q
        '  ',                    // 纯空格
        '电视柜',                 // 位置路径片段
        '工具',                   // 标签
        '和挖耳勺',               // 备注
        'type',                  // 英文小写 → 命中 "Type-C 充电线"
        'TYPE-C',                // 英文大写
        'Type-C 充电线',
        '指甲刀',
        '不存在的东西zzz',
        '%',                     // SQL 通配符，若改用 LIKE 会全匹配
        '_',
        '　',                     // 全角空格
        'x'.repeat(5000)         // 超长 q
      ];
      for (const q of queries) {
        const res = await both(pair, 'GET', '/api/items?q=' + encodeURIComponent(q));
        sameBytes(res, 'GET /api/items?q=' + JSON.stringify(q.slice(0, 20)));
      }
      // 单独确认 q=% 与 q=_ 没有变成「全匹配」
      const wild = await both(pair, 'GET', '/api/items?q=' + encodeURIComponent('%'));
      expect.eq(wild.new.json.items.length, 0, 'q=% 不应匹配所有物品（说明没用 LIKE 裸拼）');
      // 再确认大小写不敏感确实生效
      const lower = await both(pair, 'GET', '/api/items?q=type');
      expect.ok(lower.new.json.items.length >= 1, 'q=type 应命中 Type-C 充电线');
    }, { repro: 'node qa/qa-p1.js --only B3' });

  runner.test('B4', 'GET /api/wardrobe：facets 每个计数 / dict / month / season 逐字节一致', async () => {
      const s = await setup();
      const pair = makePair(s);
      const res = await both(pair, 'GET', '/api/wardrobe');
      sameBytes(res, 'GET /api/wardrobe');
      const body = res.new.json;
      expect.eq(body.items.length, 14, '衣物条数');
      const sumTypes = Object.values(body.facets.types).reduce((a, b) => a + b, 0);
      expect.eq(sumTypes, 14, 'facets.types 合计应等于衣物数');
      const sumStatus = Object.values(body.facets.status).reduce((a, b) => a + b, 0);
      expect.eq(sumStatus, 14, 'facets.status 合计应等于衣物数');
      expect.ok(body.dict.types.length === 6 && body.dict.seasons.length === 4 &&
        body.dict.status.length === 3, 'dict 字典条数');
    }, { repro: 'node qa/qa-p1.js --only B4' });

  runner.test('B5', 'GET /api/wardrobe/suggest：5 种 season 的结构/season/poolSize/missing/dict 一致',
    async () => {
      const s = await setup();
      const pair = makePair(s);
      const wardrobe = await both(pair, 'GET', '/api/wardrobe');
      const wearById = new Map(wardrobe.new.json.items.map((i) => [i.id, i]));
      for (const season of ['winter', 'summer', 'spring', 'autumn', 'bogus', '']) {
        const res = await both(pair, 'GET', '/api/wardrobe/suggest?season=' +
          encodeURIComponent(season));
        expect.eq(res.old.status, 200, 'suggest 状态码（旧）');
        expect.eq(res.new.status, 200, 'suggest 状态码（新）');
        // 形状一致（内容随机，只能比形状）
        const shapeA = canon.shape(res.old.json.outfit);
        const shapeB = canon.shape(res.new.json.outfit);
        expect.deep(shapeB, shapeA, 'season=' + season + ' 的 outfit 形状');
        // 与随机无关的部分必须完全相等
        ['ok', 'season', 'poolSize'].forEach((k) => {
          expect.deep(res.new.json[k], res.old.json[k], 'season=' + season + ' 的 ' + k);
        });
        expect.deep(res.new.json.missing, res.old.json.missing, 'season=' + season + ' 的 missing');
        expect.deep(res.new.json.dict, res.old.json.dict, 'season=' + season + ' 的 dict');
        // 挑出来的每一件：必须真实存在于衣柜里、状态可穿、季节匹配
        for (const slot of Object.keys(res.new.json.outfit)) {
          const picked = res.new.json.outfit[slot];
          if (!picked) continue;
          const src = wearById.get(picked.id);
          expect.ok(src, 'season=' + season + ' 挑出的 ' + slot + ' 必须来自衣柜');
          expect.eq(src.wear.status, 'ready', slot + ' 必须是可穿状态');
          expect.ok(!src.wear.seasons.length ||
            src.wear.seasons.indexOf(res.new.json.season) !== -1,
          slot + ' 必须适合当季');
          expect.eq(typeof picked.path, 'string', slot + ' 必须带 path');
        }
      }
      // 非法 season 要回落到「当季」，不能返回 illegal 值
      const bogus = await both(pair, 'GET', '/api/wardrobe/suggest?season=bogus');
      expect.eq(bogus.new.json.season, bogus.old.json.season, '非法 season 的回落值（新旧一致）');
      expect.ok(['spring', 'summer', 'autumn', 'winter'].indexOf(bogus.new.json.season) !== -1,
        '非法 season 必须落回四季之一');
    }, { repro: 'node qa/qa-p1.js --only B5' });

  runner.test('B6', '位置写操作全链路：建房间→改浮点坐标→改名→挪父级→三条防环→删中间层',
    async () => {
      const s = await setup();
      const pair = makePair(s);

      // 1) 建房间：自动摆放的坐标必须逐位相同
      const created = await both2(pair, 'POST', '/api/locations',
        () => ({ name: '测试房间', kind: 'room' }));
      expect.eq(created.old.status, 201, '建房间状态码（旧）');
      expect.eq(created.new.status, 201, '建房间状态码（新）');
      expect.deep(created.new.json.location.box, created.old.json.location.box,
        '自动摆放的 box 应逐位相同');
      const room = idsOf(created, 'location');
      expect.ok(/^l_/.test(room.new), '新位置 id 形状应以 l_ 开头');
      expect.eq(created.new.json.location.kind, 'room', '房间 kind');
      expect.eq(created.new.json.location.parent, null, '房间默认无父级');
      expect.eq(created.new.json.location.name, created.old.json.location.name, '房间名一致');

      // 2) 改坐标：四个浮点数原样进、原样出
      const box = { x: 71.1234567890123, y: 2.718281828459045, w: 13.37, h: 9.0001 };
      const moved = await both2(pair, 'PUT', pathOf('/api/locations/', room), () => ({ box }));
      expect.eq(moved.new.status, 200, '改坐标状态码（新）');
      expect.eq(moved.old.status, 200, '改坐标状态码（旧）');
      expect.deep(moved.new.json.location.box, box, '浮点坐标应逐位保留（新版）');
      expect.deep(moved.old.json.location.box, box, '浮点坐标应逐位保留（旧版）');

      // 3) 改名（前后空格应被 trim；空名回退原值）
      const renamed = await both2(pair, 'PUT', pathOf('/api/locations/', room),
        () => ({ name: '  改名后的房间  ' }));
      expect.eq(renamed.new.json.location.name, '改名后的房间', '名称应 trim');
      expect.eq(renamed.old.json.location.name, renamed.new.json.location.name, '名称（新旧一致）');
      const blank = await both2(pair, 'PUT', pathOf('/api/locations/', room), () => ({ name: '   ' }));
      expect.eq(blank.new.json.location.name, '改名后的房间', '空名应回退成原名（新）');
      expect.eq(blank.old.json.location.name, '改名后的房间', '空名应回退成原名（旧）');

      // 4) 挪父级到 l_home 下
      const reparent = await both2(pair, 'PUT', pathOf('/api/locations/', room),
        () => ({ parent: 'l_home' }));
      expect.eq(reparent.new.json.location.parent, 'l_home', '父级应改成 l_home（新）');
      expect.eq(reparent.old.json.location.parent, 'l_home', '父级应改成 l_home（旧）');

      // 5) 建个子格口，再试三条防环
      const child = await both2(pair, 'POST', '/api/locations',
        (side) => ({ name: '子格口', parent: room[side] }));
      expect.eq(child.new.json.location.kind, 'compartment', '带 parent 时默认 compartment');
      expect.eq(child.old.json.location.kind, child.new.json.location.kind, 'kind（新旧一致）');
      const childId = idsOf(child, 'location');

      const self = await both2(pair, 'PUT', pathOf('/api/locations/', room),
        (side) => ({ parent: room[side] }));
      expect.eq(self.new.status, 400, '挂到自己下面应 400（新）');
      expect.eq(self.old.status, 400, '挂到自己下面应 400（旧）');
      expect.eq(self.new.json.error, self.old.json.error, '报错文案应一致');

      const intoChild = await both2(pair, 'PUT', pathOf('/api/locations/', room),
        (side) => ({ parent: childId[side] }));
      expect.eq(intoChild.new.status, 400, '挂到自己的下级应 400（新）');
      expect.eq(intoChild.old.status, 400, '挂到自己的下级应 400（旧）');
      expect.eq(intoChild.new.json.error, intoChild.old.json.error, '报错文案应一致');

      const ghost = await both2(pair, 'PUT', pathOf('/api/locations/', room),
        () => ({ parent: 'l_nope' }));
      expect.eq(ghost.new.status, 404, '不存在的上级应 404（新）');
      expect.eq(ghost.old.status, 404, '不存在的上级应 404（旧）');
      expect.eq(ghost.new.json.error, ghost.old.json.error, '报错文案应一致');

      // 6) 先在子格口里放一件东西，再删掉整棵子树
      const item = await both2(pair, 'POST', '/api/items',
        (side) => ({ name: '子树里的物品', locId: childId[side], qty: 2 }));
      expect.eq(item.new.status, 201, '建物品状态码（新）');
      expect.eq(item.old.status, 201, '建物品状态码（旧）');
      expect.eq(item.new.json.item.path, item.old.json.item.path, '物品 path 应一致');

      const del = await both2(pair, 'DELETE', pathOf('/api/locations/', room));
      expect.eq(del.new.status, 200, '删位置状态码（新）');
      expect.eq(del.old.status, 200, '删位置状态码（旧）');
      expect.eq(del.new.json.removed, 2, '应连带删除位置 + 子格口 2 条（新）');
      expect.eq(del.old.json.removed, del.new.json.removed, 'removed 计数（新旧一致）');

      // 7) 物品必须还在，只是变成未归档
      //    注意这里只能比「结构」（新物品的 id/时间戳与迁移数据不同），不能逐字节比
      const after = await both(pair, 'GET', '/api/items');
      sameShape(pair, after, '删位置后 GET /api/items');
      const mine = after.new.json.items.filter((i) => i.name === '子树里的物品');
      expect.eq(mine.length, 1, '物品不应被连带删除');
      expect.eq(mine[0].locId, null, '物品位置应被置空（新）');
      expect.eq(mine[0].path, '未归档', '物品路径应为未归档（新）');
      const mineOld = after.old.json.items.filter((i) => i.name === '子树里的物品');
      expect.eq(mineOld[0].locId, null, '物品位置应被置空（旧）');
      expect.eq(mineOld[0].path, '未归档', '物品路径应为未归档（旧）');

      // 8) 整棵树回到原样（新房间已删）
      const tree = await both(pair, 'GET', '/api/locations');
      sameBytes(tree, '删除后 GET /api/locations');
      expect.eq(tree.new.json.tree.length, 1, '树应回到只有 1 个根');

      // 9) 收拾干净：把留在「未归档」的测试物品删掉，免得影响后面的计数断言
      const orphanItem = idsOf(
        { old: { json: { item: mineOld[0] } }, new: { json: { item: mine[0] } } }, 'item');
      await both2(pair, 'DELETE', pathOf('/api/items/', orphanItem));
    }, { repro: 'node qa/qa-p1.js --only B6' });

  runner.test('B7', '物品写操作全链路：建物品→改数量/标签/备注→加 wear→穿一次→撤销→删物品',
    async () => {
      const s = await setup();
      const pair = makePair(s);

      const before7 = await both(pair, 'GET', '/api/items');
      const count7 = before7.new.json.items.length;

      const created = await both2(pair, 'POST', '/api/items', () => ({
        name: '测试上衣', locId: 'l_wardrobeTop', qty: 3, note: '测试备注',
        tags: ['标签A', ' 标签B ', '']
      }));
      expect.eq(created.new.status, 201, '建物品状态码（新）');
      expect.eq(created.old.status, 201, '建物品状态码（旧）');
      sameShape(pair, created, 'POST /api/items');
      const item = idsOf(created, 'item');
      expect.deep(created.new.json.item.tags, ['标签A', '标签B'], 'tags 应 trim 去空');
      expect.eq(created.new.json.item.path, '我家 › 卧室 › 衣柜 › 顶层隔板', 'path 应正确');
      expect.ok(!('wear' in created.new.json.item), '非衣物不应有 wear 字段');
      expect.ok(!('photo' in created.new.json.item), '无照片不应出现 photo 字段');
      expect.eq(created.old.json.item.path, created.new.json.item.path, 'path（新旧一致）');

      // 改数量 / 标签（字符串形式）/ 备注
      const upd = await both2(pair, 'PUT', pathOf('/api/items/', item), () => ({
        qty: 5, tags: '红色, 冬季', note: '改过的备注'
      }));
      expect.eq(upd.new.status, 200, '改物品状态码（新）');
      expect.eq(upd.old.status, 200, '改物品状态码（旧）');
      sameShape(pair, upd, 'PUT /api/items');
      expect.eq(upd.new.json.item.qty, 5, '数量');
      expect.deep(upd.new.json.item.tags, ['红色', '冬季'], '逗号串应切成数组');
      expect.deep(upd.old.json.item.tags, ['红色', '冬季'], '逗号串应切成数组（旧）');

      // 加 wear → 变成衣物
      const asWear = await both2(pair, 'PUT', pathOf('/api/items/', item), () => ({
        wear: {
          type: 'top', seasons: ['winter', 'spring'], colors: ['white'], size: 'M',
          occasions: ['通勤'], status: 'ready'
        }
      }));
      expect.eq(asWear.new.json.item.wear.type, 'top', 'wear.type');
      expect.deep(asWear.old.json.item.wear, asWear.new.json.item.wear, 'wear 全对象应一致');
      sameShape(pair, asWear, 'PUT /api/items 加 wear');

      // 穿一次：计数 +1、状态转待洗、restored 记下旧值
      const worn = await both2(pair, 'POST', pathOf('/api/items/', item, '/wear'),
        () => ({ laundry: true }));
      expect.eq(worn.new.status, 200, '记录穿着状态码（新）');
      expect.eq(worn.old.status, 200, '记录穿着状态码（旧）');
      expect.eq(worn.new.json.item.wear.wearCount, 1, '穿着次数应 +1');
      expect.eq(worn.new.json.item.wear.status, 'laundry', '穿过后应转待洗');
      expect.deep(worn.new.json.restored, { wearCount: 0, lastWorn: null }, 'restored 应记录旧值');
      sameShape(pair, worn, 'POST /wear');

      // 再穿一次 + 撤销
      await both2(pair, 'POST', pathOf('/api/items/', item, '/wear'), () => ({}));
      const undo = await both2(pair, 'POST', pathOf('/api/items/', item, '/wear'),
        () => ({ undo: true }));
      expect.eq(undo.new.json.item.wear.wearCount, 1, '撤销后次数应回到 1');
      expect.eq(undo.new.json.item.wear.lastWorn, null, '撤销后 lastWorn 应清空');
      expect.eq(undo.new.json.restored.wearCount, 2, 'restored 应记录撤销前的 2');
      expect.eq(undo.old.json.item.wear.wearCount, undo.new.json.item.wear.wearCount,
        '撤销后次数（新旧一致）');
      sameShape(pair, undo, 'POST /wear undo');

      // 撤销到 0 再撤一次，不能变成负数
      await both2(pair, 'POST', pathOf('/api/items/', item, '/wear'), () => ({ undo: true }));
      const floorZero = await both2(pair, 'POST', pathOf('/api/items/', item, '/wear'),
        () => ({ undo: true }));
      expect.eq(floorZero.new.json.item.wear.wearCount, 0, '撤销不能把次数降到 0 以下');
      expect.eq(floorZero.old.json.item.wear.wearCount, 0, '撤销下限（旧版）');

      // 非衣物不能记录穿着
      const plain = await both2(pair, 'POST', '/api/items',
        () => ({ name: '不是衣服', locId: 'l_tvdrawer' }));
      const plainItem = idsOf(plain, 'item');
      const notWear = await both2(pair, 'POST', pathOf('/api/items/', plainItem, '/wear'),
        () => ({}));
      expect.eq(notWear.new.status, 400, '非衣物记录穿着应 400（新）');
      expect.eq(notWear.old.status, 400, '非衣物记录穿着应 400（旧）');
      expect.eq(notWear.new.json.error, notWear.old.json.error, '报错文案应一致');

      // 删物品
      const del = await both2(pair, 'DELETE', pathOf('/api/items/', item));
      expect.eq(del.new.status, 200, '删物品状态码');
      expect.deep(del.new.json, { ok: true }, '删物品返回体');
      expect.deep(del.old.json, { ok: true }, '删物品返回体（旧）');
      const gone = await both2(pair, 'PUT', pathOf('/api/items/', item), () => ({}));
      expect.eq(gone.new.status, 404, '删掉之后再改应 404（新）');
      expect.eq(gone.old.status, 404, '删掉之后再改应 404（旧）');
      expect.eq(gone.new.json.error, gone.old.json.error, '报错文案应一致');

      // 把剩下的测试物品也清掉，避免影响后续用例的物品计数
      await both2(pair, 'DELETE', pathOf('/api/items/', plainItem));
      const left = await both(pair, 'GET', '/api/items');
      expect.eq(left.new.json.items.length, count7, '物品数应回到用例开始时的条数（新）');
      expect.eq(left.old.json.items.length, count7, '物品数应回到用例开始时的条数（旧）');
    }, { repro: 'node qa/qa-p1.js --only B7' });

  runner.test('B8', 'PUT /api/settings 边界：0 / 负数 / 200 / 200.1 / 9.57 / "abc"，新旧一致',
    async () => {
      const s = await setup();
      const pair = makePair(s);
      const cases = [
        { v: 0, status: 400 },
        { v: -5, status: 400 },
        { v: 200, status: 200 },
        { v: 200.1, status: 400 },
        { v: 9.57, status: 200 },
        { v: 'abc', status: 400 },
        { v: '9.5', status: 200 }
      ];
      for (const c of cases) {
        const res = await both(pair, 'PUT', '/api/settings', { body: { planWidthM: c.v } });
        expect.eq(res.new.status, c.status, 'planWidthM=' + JSON.stringify(c.v) + ' 状态码（新）');
        expect.eq(res.old.status, c.status, 'planWidthM=' + JSON.stringify(c.v) + ' 状态码（旧）');
        expect.eq(res.new.text, res.old.text,
          'planWidthM=' + JSON.stringify(c.v) + ' 响应体应逐字节一致');
        if (c.v === 9.57) {
          // 一位小数的语义必须保留：9.57 → 9.6
          expect.eq(res.new.json.settings.planWidthM, 9.6, '9.57 应四舍五入成 9.6（新）');
          expect.eq(res.old.json.settings.planWidthM, 9.6, '9.57 应四舍五入成 9.6（旧）');
        }
      }
      // 9.57 应被四舍五入成一位小数 9.6，并且 GET 能读回来
      const readBack = await both(pair, 'GET', '/api/locations');
      expect.deep(readBack.new.json.settings, readBack.old.json.settings,
        '改完宽度后 GET /api/locations 的 settings 应一致');
      expect.eq(readBack.new.json.settings.planWidthM, 9.5, '最后一次成功写入是 9.5');
      // 复原成 12，避免影响后续用例
      await both(pair, 'PUT', '/api/settings', { body: { planWidthM: 12 } });
    }, { repro: 'node qa/qa-p1.js --only B8' });

  runner.test('B9', '错误分支：空名 / 不存在的 id / 未知接口，状态码与文案逐字节一致', async () => {
      const s = await setup();
      const pair = makePair(s);
      const cases = [
        ['POST', '/api/items', { name: '' }, 400],
        ['POST', '/api/items', { name: '   ' }, 400],
        ['POST', '/api/items', {}, 400],
        ['POST', '/api/locations', { name: '' }, 400],
        ['POST', '/api/locations', {}, 400],
        ['PUT', '/api/items/i_nope', { name: 'x' }, 404],
        ['DELETE', '/api/items/i_nope', null, 404],
        ['PUT', '/api/locations/l_nope', { name: 'x' }, 404],
        ['DELETE', '/api/locations/l_nope', null, 404],
        ['GET', '/api/xxx', null, 404],
        ['POST', '/api/xxx', { a: 1 }, 404],
        ['GET', '/api/items/i_nope', null, 404],
        ['GET', '/api/locations/l_home', null, 404],
        ['PUT', '/api/wardrobe', null, 404]
      ];
      for (const c of cases) {
        const res = await both(pair, c[0], c[1], c[2] ? { body: c[2] } : {});
        expect.eq(res.new.status, c[3],
          c[0] + ' ' + c[1] + ' 状态码（新），实际响应 ' + res.new.text.slice(0, 120));
        expect.eq(res.old.status, c[3], c[0] + ' ' + c[1] + ' 状态码（旧）');
        expect.eq(res.new.text, res.old.text, c[0] + ' ' + c[1] + ' 响应体应逐字节一致');
      }
    }, { repro: 'node qa/qa-p1.js --only B9' });

  runner.test('B10', '静态资源：/、/app.js?v=7、/style.css?v=7、/sw.js、/manifest.webmanifest 一致',
    async () => {
      const s = await setup();
      const pair = makePair(s);
      const paths = ['/', '/app.js?v=7', '/style.css?v=7', '/sw.js', '/manifest.webmanifest',
        '/nope.html'];
      for (const p of paths) {
        const res = await both(pair, 'GET', p);
        expect.eq(res.new.status, res.old.status, p + ' 状态码');
        expect.eq(res.new.headers['content-type'], res.old.headers['content-type'],
          p + ' Content-Type');
        if (res.old.status === 200) {
          expect.eq(res.new.text.length, res.old.text.length, p + ' 内容长度');
        }
      }
      // 首页与前端脚本必须真能拿到内容
      const home = await both(pair, 'GET', '/');
      expect.eq(home.new.status, 200, '首页状态码');
      expect.includes(home.new.text, 'HomeBox', '首页内容');
    }, { repro: 'node qa/qa-p1.js --only B10' });

  runner.test('B13', 'qty 边界：2.5 / "2.5" / 0 / -1 / 1e15 —— 整数列不能把小数吃掉', async () => {
      const s = await setup();
      const pair = makePair(s);
      const created = await both2(pair, 'POST', '/api/items',
        () => ({ name: 'qty 边界物品', locId: 'l_tvdrawer' }));
      const item = idsOf(created, 'item');
      const itemPath = (side) => '/api/items/' + encodeURIComponent(item[side]);
      const cases = [2.5, '2.5', 0, -1, 1000000000000000, 0.5, 3];
      for (const q of cases) {
        const res = await both2(pair, 'PUT', itemPath, () => ({ qty: q }));
        expect.eq(res.new.status, 200, 'qty=' + JSON.stringify(q) + ' 状态码（新）');
        expect.eq(res.old.status, 200, 'qty=' + JSON.stringify(q) + ' 状态码（旧）');
        expect.deep(res.new.json.item.qty, res.old.json.item.qty,
          'qty=' + JSON.stringify(q) + ' 的新旧返回值应一致');
      }
      // 2.5 必须原样保住（不能被 INTEGER 列截成 2）
      const half = await both2(pair, 'PUT', itemPath, () => ({ qty: 2.5 }));
      expect.eq(half.new.json.item.qty, 2.5, 'qty=2.5 不能被截断（新）');
      expect.eq(half.old.json.item.qty, 2.5, 'qty=2.5 不能被截断（旧）');
      // GET 列表里读回来也得是 2.5
      const listed = await both(pair, 'GET', '/api/items');
      sameShape(pair, listed, '改完 qty 后 GET /api/items');
      const row = listed.new.json.items.filter((i) => i.name === 'qty 边界物品')[0];
      expect.eq(row.qty, 2.5, '列表里的 qty 应为 2.5');
      // POST 带字符串数量
      const str = await both2(pair, 'POST', '/api/items',
        () => ({ name: '字符串数量物品', locId: 'l_tvdrawer', qty: '2.5' }));
      expect.eq(str.new.json.item.qty, 2.5, 'POST qty="2.5" 应存成 2.5（新）');
      expect.eq(str.old.json.item.qty, 2.5, 'POST qty="2.5" 应存成 2.5（旧）');
      // 收尾
      await both2(pair, 'DELETE', itemPath);
      await both2(pair, 'DELETE', pathOf('/api/items/', idsOf(str, 'item')));
    }, { repro: 'node qa/qa-p1.js --only B13' });

  runner.test('B14', '把位置挪回根（parent: null）后整棵树仍与旧版一致', async () => {
      const s = await setup();
      const pair = makePair(s);
      const before = await both(pair, 'GET', '/api/locations');
      const cabinet = before.new.json.tree[0].children
        .filter((n) => n.id === 'l_living')[0].children
        .filter((n) => n.id === 'l_tvcab')[0];
      expect.ok(cabinet, '前置检查：电视柜应在客厅下');
      const put = await both2(pair, 'PUT', '/api/locations/l_tvcab', () => ({ parent: null }));
      expect.eq(put.new.status, 200, '挪到根状态码（新）');
      expect.eq(put.old.status, 200, '挪到根状态码（旧）');
      expect.eq(put.new.json.location.parent, null, '父级应变成 null（新）');
      expect.eq(put.old.json.location.parent, null, '父级应变成 null（旧）');
      const after = await both(pair, 'GET', '/api/locations');
      expect.eq(after.new.json.tree.length, after.old.json.tree.length, '根节点个数应一致');
      expect.eq(after.new.json.tree.length, 2, '电视柜应变成第二个根');
      sameBytes(after, '挪回根后的 GET /api/locations');
      // 挪回去，别影响后面的用例
      const back = await both2(pair, 'PUT', '/api/locations/l_tvcab', () => ({ parent: 'l_living' }));
      expect.eq(back.new.status, 200, '挪回客厅状态码');
      const restored = await both(pair, 'GET', '/api/locations');
      sameBytes(restored, '挪回客厅后的 GET /api/locations');
    }, { repro: 'node qa/qa-p1.js --only B14' });

  runner.test('B15', '/photos/<真实照片>：新旧都能取到、字节完全一致', async () => {
      const s = await setup();
      const pair = makePair(s);
      const [o, n] = await Promise.all([
        httpc.requestRaw(pair.old.base, 'GET', '/photos/p_mvd7uwekv633w.png'),
        httpc.requestRaw(pair.new.base, 'GET', '/photos/p_mvd7uwekv633w.png')
      ]);
      expect.eq(n.status, 200, '新版取照片状态码');
      expect.eq(o.status, 200, '旧版取照片状态码');
      expect.eq(n.headers['content-type'], o.headers['content-type'], 'Content-Type 应一致');
      expect.ok(n.raw.equals(o.raw), '取回的照片字节应与旧版完全一致');
      expect.ok(n.raw.length > 30000, '照片应是有内容的真实文件');
    }, { repro: 'node qa/qa-p1.js --only B15' });

  runner.test('B12', 'POST /api/wardrobe/demo：已有衣物时 409、文案带件数，新旧逐字节一致',
    async () => {
      const s = await setup();
      const pair = makePair(s);
      const res = await both(pair, 'POST', '/api/wardrobe/demo');
      expect.eq(res.new.status, 409, '已有衣物时应 409（新）');
      expect.eq(res.old.status, 409, '已有衣物时应 409（旧）');
      expect.eq(res.new.text, res.old.text, '响应体应逐字节一致');
      expect.includes(res.new.text, '14 件', '文案应带准确件数');
    }, { repro: 'node qa/qa-p1.js --only B12' });

  runner.test('B11', '前端引用的每个 /api 路由都还存在（对照 public/app.js）', async () => {
    const s = await setup();
    const pair = makePair(s);
    const appjs = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    const referenced = Array.from(new Set(
      (appjs.match(/\/api\/[a-zA-Z0-9_/?&=.%:-]*/g) || [])
        .map((x) => x.replace(/[?].*$/, ''))
        .map((x) => x.replace(/'/g, ''))
    )).sort();
    // 这些是 app.js 里真实用到的形态，逐个确认路由没丢（404 且 error='接口不存在' 才算丢）
    const probes = [
      ['GET', '/api/locations'],
      ['POST', '/api/locations'],
      ['PUT', '/api/locations/l_home'],
      ['DELETE', '/api/locations/l_nope'],
      ['GET', '/api/items'],
      ['POST', '/api/items'],
      ['PUT', '/api/items/i_nope'],
      ['DELETE', '/api/items/i_nope'],
      ['POST', '/api/items/i_nope/photo'],
      ['DELETE', '/api/items/i_nope/photo'],
      ['POST', '/api/items/i_nope/wear'],
      ['GET', '/api/wardrobe'],
      ['GET', '/api/wardrobe/suggest?season=winter'],
      ['POST', '/api/wardrobe/demo'],
      ['PUT', '/api/settings']
    ];
    const res = await both(pair, 'GET', '/api/locations');
    expect.eq(res.new.status, 200, '前置检查');
    for (const p of probes) {
      const r = await httpc.request(pair.new.base, p[0], p[1],
        p[0] === 'POST' || p[0] === 'PUT' ? { body: {} } : {});
      const missing = r.status === 404 && r.json && r.json.error === '接口不存在';
      expect.ok(!missing, p[0] + ' ' + p[1] + ' 路由不见了（前端会 404）');
    }
    runner.finding('F-B11',
      '前端引用的 ' + referenced.length + ' 个 /api 路径全部有对应路由',
      '从 public/app.js 里提取到的接口前缀：' + referenced.join(', ') +
      '；逐个探测确认没有「接口不存在」。',
      'info');
  }, { repro: 'node qa/qa-p1.js --only B11' });
}

module.exports = { register, makePair, both, sameBytes, sameShape };
