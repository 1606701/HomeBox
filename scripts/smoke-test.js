#!/usr/bin/env node
'use strict';

// 接口冒烟测试（独立可跑）
//
//   node scripts/smoke-test.js
//
// 做法：在系统临时目录里起一份全新的数据目录，用随机端口拉起 server.js，
// 然后串行打完 P1 阶段全部 14 个接口，逐条断言关键返回，最后杀掉进程、删临时目录。
// 全程不碰 data/ 里的真实数据。
//
// 任何一条断言失败 → 退出码 1，并打印失败清单。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');

// 1x1 PNG（够服务端做文件头校验）
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+4wAAAABJRU5ErkJggg==';

const results = [];

/**
 * 记一条断言。
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 明细
 */
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

/**
 * 跑一个测试步骤，异常也记成失败而不中断整轮。
 * @param {string} name 步骤名
 * @param {() => Promise<void>} fn 步骤体
 */
async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name + '（步骤异常）', false, err && err.message ? err.message : String(err));
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 起服务并等到端口真的能回应。
 * @param {string} dataDir 数据目录
 * @param {number} port 端口
 * @returns {Promise<{child:import('child_process').ChildProcess, base:string, logs:string[]}>}
 */
async function startServer(dataDir, port) {
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      HOST: '127.0.0.1',
      HB_DATA_DIR: dataDir,
      NODE_NO_WARNINGS: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('服务提前退出，退出码 ' + child.exitCode + '\n' + logs.join(''));
    }
    try {
      const res = await fetch(base + '/api/locations');
      if (res.ok) return { child, base, logs };
    } catch (err) {
      // 还没起来，继续等
    }
    await sleep(150);
  }
  throw new Error('服务 20 秒内没起来\n' + logs.join(''));
}

/**
 * 薄薄一层 JSON 请求封装。
 * @param {string} base 服务地址
 * @param {string} method HTTP 方法
 * @param {string} p 路径
 * @param {*} [body] 请求体
 * @returns {Promise<{status:number, json:any}>}
 */
async function call(base, method, p, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  let json = null;
  try { json = await res.json(); } catch (err) { json = null; }
  return { status: res.status, json };
}

/**
 * 深度优先收集树里所有节点。
 * @param {object[]} roots 根节点数组
 * @returns {object[]} 扁平节点数组
 */
function flatten(roots) {
  const out = [];
  const walk = (node) => {
    out.push(node);
    (node.children || []).forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

function findNode(roots, id) {
  return flatten(roots).find((n) => n.id === id) || null;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebox-smoke-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  let started = null;
  let exitCode = 0;

  try {
    started = await startServer(dataDir, port);
    const base = started.base;

    /* ---------- 0 静态资源 ---------- */
    await step('静态首页', async () => {
      const res = await fetch(base + '/');
      const text = await res.text();
      check('GET / 返回 200 且是 HTML', res.status === 200 && /<html/i.test(text),
        'status=' + res.status);
    });

    /* ---------- 1 位置树 ---------- */
    let baselineTree = null;
    await step('位置树与计数', async () => {
      const r = await call(base, 'GET', '/api/locations');
      baselineTree = r.json && r.json.tree;
      check('GET /api/locations 返回 ok/tree/settings',
        r.status === 200 && r.json.ok === true && Array.isArray(r.json.tree) && !!r.json.settings,
        'status=' + r.status);
      check('settings.planWidthM 是数字 12',
        r.json && r.json.settings && r.json.settings.planWidthM === 12,
        r.json && r.json.settings ? JSON.stringify(r.json.settings) : '无 settings');
      const all = flatten(baselineTree || []);
      check('示例数据 19 个位置', all.length === 19, '实际 ' + all.length);
      const root = (baselineTree || [])[0];
      check('根节点 totalCount 含子孙递归合计 26',
        !!root && root.totalCount === 26, root ? String(root.totalCount) : '无根节点');
      const wardrobe = findNode(baselineTree, 'l_wardrobe');
      check('衣柜节点 itemCount=0 且 totalCount=13',
        !!wardrobe && wardrobe.itemCount === 0 && wardrobe.totalCount === 13,
        wardrobe ? wardrobe.itemCount + '/' + wardrobe.totalCount : '找不到衣柜');
      check('格口没有坐标（box 为 null）',
        !!findNode(baselineTree, 'l_tvdrawer') && findNode(baselineTree, 'l_tvdrawer').box === null);
    });

    /* ---------- 2 物品列表与搜索 ---------- */
    await step('物品列表与搜索', async () => {
      const r = await call(base, 'GET', '/api/items');
      const list = r.json && r.json.items;
      check('GET /api/items 返回 26 条', r.status === 200 && Array.isArray(list) && list.length === 26,
        '实际 ' + (list ? list.length : 'null'));
      const first = (list || []).find((i) => i.name === '指甲刀');
      check('每条 item 带全角 › 拼的 path',
        !!first && first.path === '我家 › 客厅 › 电视柜 › 左侧抽屉',
        first ? first.path : '找不到指甲刀');
      const stamps = (list || []).map((i) => String(i.updatedAt));
      const sorted = stamps.slice().sort((a, b) => b.localeCompare(a));
      check('列表按 updatedAt 倒序', stamps.join('|') === sorted.join('|'));

      const one = await call(base, 'GET', '/api/items?q=' + encodeURIComponent('指甲'));
      check('中文关键词搜索命中 1 条',
        one.status === 200 && one.json.items.length === 1,
        '实际 ' + (one.json && one.json.items ? one.json.items.length : 'null'));

      const byTag = await call(base, 'GET', '/api/items?q=' + encodeURIComponent('药品'));
      check('标签命中搜索（药品 2 条）',
        byTag.json && byTag.json.items && byTag.json.items.length === 2,
        '实际 ' + (byTag.json && byTag.json.items ? byTag.json.items.length : 'null'));

      const byPath = await call(base, 'GET', '/api/items?q=' + encodeURIComponent('衣柜'));
      const pathHits = byPath.json ? byPath.json.items : [];
      check('路径命中搜索且结果都在衣柜下',
        pathHits.length > 0 && pathHits.every((i) => i.path.indexOf('衣柜') !== -1),
        '命中 ' + pathHits.length + ' 条');

      const caseTest = await call(base, 'GET', '/api/items?q=type-c');
      check('搜索大小写不敏感（type-c 命中 Type-C 充电线）',
        caseTest.json && caseTest.json.items.length === 1,
        '实际 ' + (caseTest.json && caseTest.json.items ? caseTest.json.items.length : 'null'));

      const none = await call(base, 'GET', '/api/items?q=' + encodeURIComponent('不存在的关键词zzz'));
      check('搜不到时返回空数组', none.json && none.json.items.length === 0);
    });

    /* ---------- 3 位置增改删 + 防环 ---------- */
    let roomId = null;
    let furnId = null;
    let orphanItemId = null;
    await step('位置增改删与防环', async () => {
      const created = await call(base, 'POST', '/api/locations',
        { name: '测试房间', kind: 'room', parent: 'l_home' });
      roomId = created.json && created.json.location ? created.json.location.id : null;
      const box = created.json && created.json.location ? created.json.location.box : null;
      check('POST /api/locations 建房间返回 201 且自动分配坐标',
        created.status === 201 && !!roomId && !!box &&
        [box.x, box.y, box.w, box.h].every((n) => Number.isFinite(n)),
        JSON.stringify(box));

      const bad = await call(base, 'POST', '/api/locations', { name: '   ' });
      check('空名称返回 400「位置名称不能为空」',
        bad.status === 400 && bad.json.error === '位置名称不能为空', bad.json && bad.json.error);

      const furn = await call(base, 'POST', '/api/locations',
        { name: '测试家具', kind: 'furniture', parent: roomId });
      furnId = furn.json && furn.json.location ? furn.json.location.id : null;
      check('POST /api/locations 建家具落在父房间内',
        furn.status === 201 && !!furnId && !!furn.json.location.box &&
        furn.json.location.box.x >= box.x && furn.json.location.box.y >= box.y,
        JSON.stringify(furn.json && furn.json.location ? furn.json.location.box : null));

      const renamed = await call(base, 'PUT', '/api/locations/' + encodeURIComponent(roomId),
        { name: '测试房间2' });
      check('PUT 改名生效',
        renamed.status === 200 && renamed.json.location.name === '测试房间2',
        renamed.json && renamed.json.location ? renamed.json.location.name : 'null');

      const moved = await call(base, 'PUT', '/api/locations/' + encodeURIComponent(roomId),
        { box: { x: 10.5, y: 11.25, w: 8, h: 6 } });
      const mb = moved.json && moved.json.location ? moved.json.location.box : null;
      check('PUT 改坐标浮点精度不丢（10.5/11.25/8/6）',
        moved.status === 200 && !!mb &&
        mb.x === 10.5 && mb.y === 11.25 && mb.w === 8 && mb.h === 6,
        JSON.stringify(mb));

      const self = await call(base, 'PUT', '/api/locations/' + encodeURIComponent(roomId),
        { parent: roomId });
      check('防环：挂到自己下面 → 400「不能挂到自己下面」',
        self.status === 400 && self.json.error === '不能挂到自己下面', self.json && self.json.error);

      const down = await call(base, 'PUT', '/api/locations/l_living', { parent: 'l_tvdrawer' });
      check('防环：挂到自己的下级里 → 400「不能挂到自己的下级里」',
        down.status === 400 && down.json.error === '不能挂到自己的下级里',
        down.json && down.json.error);

      const ghost = await call(base, 'PUT', '/api/locations/' + encodeURIComponent(roomId),
        { parent: 'l_not_exist' });
      check('防环：上级不存在 → 404「上级位置不存在」',
        ghost.status === 404 && ghost.json.error === '上级位置不存在',
        ghost.json && ghost.json.error);

      const missing = await call(base, 'PUT', '/api/locations/l_not_exist', { name: 'x' });
      check('改不存在的位置 → 404「位置不存在」',
        missing.status === 404 && missing.json.error === '位置不存在',
        missing.json && missing.json.error);

      // 在测试家具里放一件东西，然后删房间，验证物品不被删、locId 被置空
      const it = await call(base, 'POST', '/api/items',
        { name: '会被腾空的物品', locId: furnId, qty: 1 });
      orphanItemId = it.json && it.json.item ? it.json.item.id : null;

      const del = await call(base, 'DELETE', '/api/locations/' + encodeURIComponent(roomId));
      check('DELETE 位置连子孙一起删（removed=2）',
        del.status === 200 && del.json.removed === 2, JSON.stringify(del.json));

      const after = await call(base, 'GET', '/api/items?q=' + encodeURIComponent('会被腾空'));
      const left = after.json && after.json.items ? after.json.items[0] : null;
      check('删位置后物品还在，locId 置空且 path 变「未归档」',
        !!left && left.locId === null && left.path === '未归档',
        left ? JSON.stringify({ locId: left.locId, path: left.path }) : '物品不见了');
    });

    /* ---------- 4 物品增改删 ---------- */
    let itemId = null;
    await step('物品增改删', async () => {
      const created = await call(base, 'POST', '/api/items', {
        name: '测试物品', locId: 'l_tvdrawer', note: '冒烟测试', qty: 3, tags: '甲,乙'
      });
      itemId = created.json && created.json.item ? created.json.item.id : null;
      const item = created.json ? created.json.item : null;
      check('POST /api/items 返回 201 且 tags 按分隔符切开',
        created.status === 201 && !!itemId &&
        item.tags.length === 2 && item.tags[0] === '甲' && item.tags[1] === '乙',
        JSON.stringify(item && item.tags));
      check('新建物品带正确 path', !!item && item.path === '我家 › 客厅 › 电视柜 › 左侧抽屉',
        item ? item.path : 'null');

      const bad = await call(base, 'POST', '/api/items', { name: '' });
      check('空名称返回 400「物品名称不能为空」',
        bad.status === 400 && bad.json.error === '物品名称不能为空', bad.json && bad.json.error);

      const upd = await call(base, 'PUT', '/api/items/' + encodeURIComponent(itemId),
        { qty: 5, note: '改过了', locId: 'l_mirrorCab' });
      const u = upd.json ? upd.json.item : null;
      check('PUT 改数量/备注/位置生效',
        upd.status === 200 && !!u && u.qty === 5 && u.note === '改过了' &&
        u.locId === 'l_mirrorCab' && u.path === '我家 › 卫生间 › 镜柜',
        u ? JSON.stringify({ qty: u.qty, note: u.note, path: u.path }) : 'null');

      const noQty = await call(base, 'PUT', '/api/items/' + encodeURIComponent(itemId), { qty: -1 });
      check('PUT 非法数量被忽略（保持 5）',
        noQty.status === 200 && noQty.json.item.qty === 5, String(noQty.json.item.qty));

      const miss = await call(base, 'PUT', '/api/items/i_not_exist', { name: 'x' });
      check('改不存在的物品 → 404「物品不存在」',
        miss.status === 404 && miss.json.error === '物品不存在', miss.json && miss.json.error);
    });

    /* ---------- 5 照片管线 ---------- */
    await step('照片上传/读取/换图/删除', async () => {
      const up = await call(base, 'POST', '/api/items/' + encodeURIComponent(itemId) + '/photo',
        { data: 'data:image/png;base64,' + PNG_BASE64 });
      const photo = up.json ? up.json.photo : null;
      const firstFile = photo ? photo.file : null;
      check('POST 照片返回 200 且识别为 png',
        up.status === 200 && !!firstFile && photo.ext === 'png' && photo.bytes > 0,
        JSON.stringify(photo));
      check('上传后 item.photo 指向新文件',
        !!(up.json && up.json.item && up.json.item.photo === firstFile));

      const img = await fetch(base + '/photos/' + firstFile);
      const buf = Buffer.from(await img.arrayBuffer());
      check('GET /photos/:file 返回 200 且是 PNG',
        img.status === 200 && img.headers.get('content-type') === 'image/png' &&
        buf.length === photo.bytes, 'status=' + img.status + ' bytes=' + buf.length);

      const again = await call(base, 'POST', '/api/items/' + encodeURIComponent(itemId) + '/photo',
        { data: PNG_BASE64 });
      const secondFile = again.json && again.json.photo ? again.json.photo.file : null;
      check('换图后文件名变化', !!secondFile && secondFile !== firstFile,
        firstFile + ' → ' + secondFile);
      const old = await fetch(base + '/photos/' + firstFile);
      check('换图后旧文件已删除（404）', old.status === 404, 'status=' + old.status);

      const badData = await call(base, 'POST', '/api/items/' + encodeURIComponent(itemId) + '/photo',
        { data: 'bm90LWFuLWltYWdl' });
      check('非法图片返回 400',
        badData.status === 400 && /不支持的图片格式/.test(badData.json.error),
        badData.json && badData.json.error);

      const del = await call(base, 'DELETE', '/api/items/' + encodeURIComponent(itemId) + '/photo');
      check('DELETE 照片后 item 没有 photo 字段',
        del.status === 200 && del.json.item && del.json.item.photo === undefined,
        JSON.stringify(del.json && del.json.item ? del.json.item.photo : 'null'));
      const gone = await fetch(base + '/photos/' + secondFile);
      check('DELETE 照片后文件也没了（404）', gone.status === 404, 'status=' + gone.status);
    });

    /* ---------- 6 衣柜 ---------- */
    await step('衣柜列表与 facets', async () => {
      const r = await call(base, 'GET', '/api/wardrobe');
      const body = r.json || {};
      const list = body.items || [];
      const types = (body.dict && body.dict.types) || [];
      const seasons = (body.dict && body.dict.seasons) || [];
      const status = (body.dict && body.dict.status) || [];
      check('GET /api/wardrobe 返回 14 件衣物', r.status === 200 && list.length === 14,
        '实际 ' + list.length);
      check('dict 三张字典齐全（6/4/3）',
        types.length === 6 && seasons.length === 4 && status.length === 3,
        types.length + '/' + seasons.length + '/' + status.length);
      check('month 是 1–12 的整数',
        Number.isInteger(body.month) && body.month >= 1 && body.month <= 12, String(body.month));
      check('season 合法',
        ['spring', 'summer', 'autumn', 'winter'].indexOf(body.season) !== -1, body.season);
      check('facets.types.top 与逐件统计一致',
        body.facets && body.facets.types.top ===
          list.filter((i) => i.wear.type === 'top').length,
        JSON.stringify(body.facets && body.facets.types));
      check('facets.status 之和等于衣物总数',
        body.facets && Object.keys(body.facets.status)
          .reduce((s, k) => s + body.facets.status[k], 0) === list.length,
        JSON.stringify(body.facets && body.facets.status));
      check('每件都带 wear.idleDays（当前全为 null）',
        list.every((i) => i.wear && i.wear.idleDays === null));
      check('每件衣物都带 path', list.every((i) => typeof i.path === 'string' && i.path.length > 0));
    });

    /* ---------- 7 今日穿什么 ---------- */
    await step('建议搭配', async () => {
      const r = await call(base, 'GET', '/api/wardrobe/suggest?season=autumn');
      const body = r.json || {};
      const outfit = body.outfit || {};
      check('suggest 返回 season/poolSize/outfit/missing/dict',
        r.status === 200 && body.season === 'autumn' && typeof body.poolSize === 'number' &&
        !!body.outfit && Array.isArray(body.missing) && !!body.dict,
        JSON.stringify({ season: body.season, poolSize: body.poolSize }));
      check('outfit 六个槽位齐全',
        ['top', 'bottom', 'dress', 'outer', 'shoes', 'accessory']
          .every((k) => Object.prototype.hasOwnProperty.call(outfit, k)),
        Object.keys(outfit).join(','));
      check('有连衣裙时不出上衣下装',
        !outfit.dress || (outfit.top === null && outfit.bottom === null),
        'dress=' + !!outfit.dress);
      check('未配齐的槽位进 missing（accessory 除外）',
        body.missing.every((k) => k !== 'accessory' && !outfit[k]),
        body.missing.join(','));
    });

    /* ---------- 8 穿戴计数与撤销 ---------- */
    await step('穿戴 +1 与 undo', async () => {
      const before = await call(base, 'GET', '/api/wardrobe');
      const target = (before.json.items || []).find((i) => i.wear.status === 'ready');
      check('能找到一件「可穿」的衣服', !!target, target ? target.name : '没有');
      if (!target) return;

      const worn = await call(base, 'POST', '/api/items/' + encodeURIComponent(target.id) + '/wear', {});
      const w = worn.json ? worn.json.item : null;
      check('POST wear：wearCount+1 且状态转待洗',
        worn.status === 200 && !!w && w.wear.wearCount === target.wear.wearCount + 1 &&
        w.wear.status === 'laundry' && !!w.wear.lastWorn,
        w ? JSON.stringify({ c: w.wear.wearCount, s: w.wear.status }) : 'null');
      check('restored 里带着穿之前的次数',
        worn.json && worn.json.restored && worn.json.restored.wearCount === target.wear.wearCount,
        JSON.stringify(worn.json && worn.json.restored));

      const undo = await call(base, 'POST', '/api/items/' + encodeURIComponent(target.id) + '/wear',
        { undo: true });
      const u = undo.json ? undo.json.item : null;
      check('POST wear undo：次数减一且 lastWorn 归 null',
        undo.status === 200 && !!u && u.wear.wearCount === target.wear.wearCount &&
        u.wear.lastWorn === null,
        u ? JSON.stringify({ c: u.wear.wearCount, l: u.wear.lastWorn }) : 'null');

      const notWear = await call(base, 'POST', '/api/items/l_not_exist/wear', {});
      check('wear 不存在的物品 → 404「找不到这件东西」',
        notWear.status === 404 && notWear.json.error === '找不到这件东西',
        notWear.json && notWear.json.error);

      const nonWear = await call(base, 'POST', '/api/items/' + encodeURIComponent(itemId) + '/wear', {});
      check('wear 非衣物 → 400「它不是衣服」',
        nonWear.status === 400 && nonWear.json.error === '它不是衣服',
        nonWear.json && nonWear.json.error);
    });

    /* ---------- 9 户型设置 ---------- */
    await step('户型宽度设置', async () => {
      const bad = await call(base, 'PUT', '/api/settings', { planWidthM: 0 });
      check('宽度 0 → 400「宽度要填一个正数（米）」',
        bad.status === 400 && bad.json.error === '宽度要填一个正数（米）',
        bad.json && bad.json.error);

      const tooBig = await call(base, 'PUT', '/api/settings', { planWidthM: 500 });
      check('宽度 500 → 400（上限 200）', tooBig.status === 400);

      const ok = await call(base, 'PUT', '/api/settings', { planWidthM: 9.57 });
      check('宽度保存保留一位小数（9.57 → 9.6）',
        ok.status === 200 && ok.json.settings.planWidthM === 9.6,
        JSON.stringify(ok.json && ok.json.settings));

      const after = await call(base, 'GET', '/api/locations');
      check('GET /api/locations 能读到新宽度',
        after.json.settings.planWidthM === 9.6, JSON.stringify(after.json.settings));

      await call(base, 'PUT', '/api/settings', { planWidthM: 12 });
    });

    /* ---------- 10 示例导入 409 分支 ---------- */
    await step('示例衣物导入的 409 分支', async () => {
      const r = await call(base, 'POST', '/api/wardrobe/demo');
      check('已有衣物时导入返回 409 且文案带件数',
        r.status === 409 && /已经有 \d+ 件衣服了，不需要再导入示例/.test(r.json.error),
        r.json && r.json.error);
    });

    /* ---------- 11 未知接口 ---------- */
    await step('未知接口', async () => {
      const r = await call(base, 'GET', '/api/not-exist');
      check('未知 API → 404「接口不存在」',
        r.status === 404 && r.json.error === '接口不存在', r.json && r.json.error);

      const itemGet = await call(base, 'GET', '/api/items/' + encodeURIComponent(itemId));
      check('GET /api/items/:id 不存在该路由（仍是 404 接口不存在）',
        itemGet.status === 404 && itemGet.json.error === '接口不存在',
        itemGet.json && itemGet.json.error);

      const ghost = await call(base, 'DELETE', '/api/items/i_not_exist');
      check('删不存在的物品 → 404「物品不存在」',
        ghost.status === 404 && ghost.json.error === '物品不存在',
        ghost.json && ghost.json.error);
    });

    /* ---------- 12 删物品 ---------- */
    await step('删除物品', async () => {
      const del = await call(base, 'DELETE', '/api/items/' + encodeURIComponent(itemId));
      check('DELETE /api/items/:id 返回 ok', del.status === 200 && del.json.ok === true);
      const all = await call(base, 'GET', '/api/items');
      check('删除后列表里没有了',
        (all.json.items || []).every((i) => i.id !== itemId));
    });

    /* ---------- 13 位置树仍然自洽 ---------- */
    await step('收尾一致性', async () => {
      const r = await call(base, 'GET', '/api/locations');
      const all = flatten(r.json.tree || []);
      check('删改之后树里没有孤儿（节点数 = 位置总数）',
        all.length === 19, '实际 ' + all.length);
      check('每个节点都有 itemCount/totalCount 且后者不小于前者',
        all.every((n) => Number.isInteger(n.itemCount) && Number.isInteger(n.totalCount) &&
          n.totalCount >= n.itemCount));
      const total = all.filter((n) => !n.parent).reduce((s, n) => s + n.totalCount, 0);
      check('根节点合计等于物品总数', total === 26, '实际 ' + total);
    });

    // 启动日志不该有异常噪音
    const logs = started.logs.join('');
    check('启动日志干净（无 ExperimentalWarning 之外的报错）',
      !/\[api error\]|\[fatal\]|Error:/.test(logs),
      logs.split('\n').filter((l) => /error|Error|fatal/.test(l)).join(' | '));
  } catch (err) {
    check('冒烟测试整体运行', false, err && err.message ? err.message : String(err));
  } finally {
    if (started && started.child) {
      try { started.child.kill('SIGTERM'); } catch (err) { /* 已经没了 */ }
    }
    await sleep(200);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
  }

  /* ---------- 报告 ---------- */
  const passed = results.filter((r) => r.ok).length;
  console.log('');
  console.log('HomeBox P1 接口冒烟测试');
  console.log('────────────────────────────────────────────');
  results.forEach((r) => {
    console.log('  [' + (r.ok ? 'PASS' : 'FAIL') + '] ' + r.name + (r.detail ? '  —— ' + r.detail : ''));
  });
  console.log('');
  console.log('通过 ' + passed + ' / ' + results.length);
  console.log('');
  if (passed !== results.length) exitCode = 1;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[fatal] 冒烟测试崩溃：', err);
  process.exit(1);
});
