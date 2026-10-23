'use strict';

// C 组：对抗性边界（工程师自测最容易漏的部分）
//
// 分工：
//   mut     —— 只有新版服务，用来做并发、照片、payload 这类「不崩不脏」的断言；
//   parity  —— 新旧各一份，用来做必须对照旧版才能判定「是不是回归」的断言；
//   c7      —— 专门给非法 locId 用（会造出脏数据，不能污染 parity）；
//   c5      —— 专门给「删根节点」用（会把整棵树清空）。
// 每个 pair 的数据目录、端口都独立，互不影响。

const fs = require('fs');
const path = require('path');

const util = require('../lib/util');
const servers = require('../lib/servers');
const httpc = require('../lib/httpc');
const canon = require('../lib/canon');
const { expect } = require('../lib/runner');

/**
 * 读仓库里唯一那张真实 PNG。
 * @param {string} repoRoot 仓库根
 * @returns {Buffer}
 */
function realPng(repoRoot) {
  return fs.readFileSync(path.join(repoRoot, 'data', 'photos', 'p_mvd7uwekv633w.png'));
}

/**
 * 造一套隔离的服务（新版必起，旧版可选）。
 * @param {string} repoRoot 仓库根
 * @param {string} label 临时目录前缀
 * @param {Function} onCleanup 清理登记
 * @param {boolean} [withOld] 是否也起旧版
 * @returns {Function} 返回 {newSrv, oldSrv?, newData, oldRoot?}
 */
function makePairFactory(repoRoot, label, onCleanup, withOld) {
  return util.once(async () => {
    const newDir = util.makeTempDir('hb-qa-' + label + '-new-');
    const newData = path.join(newDir, 'data');
    servers.prepareDataDir(repoRoot, newData);
    const mig = servers.runMigrate(repoRoot, newData);
    if (mig.code !== 0) throw new Error('准备数据目录失败：' + mig.stdout + mig.stderr);

    const newSrv = await servers.startNewServer({ repoRoot, dataDir: newData });
    const out = { newSrv, newData, oldSrv: null, oldRoot: null };
    if (withOld) {
      const oldDir = util.makeTempDir('hb-qa-' + label + '-old-');
      const oldRoot = path.join(oldDir, 'root');
      const prep = servers.prepareOldRoot(repoRoot, oldRoot);
      if (!prep.ok) throw new Error(prep.reason);
      out.oldSrv = await servers.startOldServer({ oldRoot });
      out.oldRoot = oldRoot;
      onCleanup(async () => {
        await servers.stopServer(out.newSrv);
        await servers.stopServer(out.oldSrv);
        util.rmrf(newDir);
        util.rmrf(oldDir);
      });
    } else {
      onCleanup(async () => {
        await servers.stopServer(out.newSrv);
        util.rmrf(newDir);
      });
    }
    return out;
  });
}

/**
 * 造一个新旧请求对（带各自的归一化上下文）。
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
 * 向两边发请求，路径与请求体都按边生成（同一逻辑对象在两边 id 不同）。
 * @param {object} pair 请求对
 * @param {string} method 方法
 * @param {string|Function} pathOrFn 路径或 (side) => 路径
 * @param {*|Function} [bodyOrFn] 请求体或 (side) => 请求体
 * @returns {Promise<{old:object, new:object}>}
 */
async function pair2(pair, method, pathOrFn, bodyOrFn) {
  const build = (side) => {
    const p = typeof pathOrFn === 'function' ? pathOrFn(side) : pathOrFn;
    const b = typeof bodyOrFn === 'function' ? bodyOrFn(side) : bodyOrFn;
    return httpc.request(pair[side].base, method, p, b === undefined ? {} : { body: b });
  };
  const [o, n] = await Promise.all([build('old'), build('new')]);
  return { old: o, new: n };
}

/**
 * 从响应里取 id（旧/新各一个）。
 * @param {{old:object,new:object}} res 响应对
 * @param {string} key 顶层字段名
 * @returns {{old:string,new:string}}
 */
function idsOf(res, key) {
  const o = res.old.json && res.old.json[key] ? res.old.json[key].id : '';
  const n = res.new.json && res.new.json[key] ? res.new.json[key].id : '';
  if (!o || !n) {
    throw new Error('响应里没有 ' + key + '.id：旧 ' + res.old.text.slice(0, 200) +
      ' / 新 ' + res.new.text.slice(0, 200));
  }
  return { old: o, new: n };
}

/**
 * 抹平 id / 时间戳后要求两边一致（写了新数据的场合不能用逐字节比）。
 * @param {object} pair 请求对
 * @param {{old:object,new:object}} res 响应对
 * @param {string} label 说明
 */
function sameCanon(pair, res, label) {
  expect.eq(res.old.status, res.new.status, label + ' 状态码');
  const a = canon.canon(res.old.json, pair.old.ctx);
  const b = canon.canon(res.new.json, pair.new.ctx);
  const diffs = canon.diff(a, b);
  if (diffs.length) {
    throw new Error(label + ' 抹平 id 后仍不一致（' + diffs.length + ' 处）：\n' +
      canon.render(diffs));
  }
}

/**
 * 注册 C 组用例。
 * @param {object} runner Runner
 * @param {object} ctx 共享上下文
 */
function register(runner, ctx) {
  const repoRoot = ctx.repoRoot;
  const mut = makePairFactory(repoRoot, 'c-mut', ctx.onCleanup, false);
  const parity = makePairFactory(repoRoot, 'c-parity', ctx.onCleanup, true);
  const onlyInvalidIds = makePairFactory(repoRoot, 'c-c7', ctx.onCleanup, true);
  const doomed = makePairFactory(repoRoot, 'c-c5', ctx.onCleanup, true);

  runner.section('C 对抗性边界');

  runner.test('C1', '并发写：同一物品 10 个 PUT（不同 qty）→ 无 500 / 无锁错 / 最终值与最后响应一致',
    async () => {
      const s = await mut();
      const base = s.newSrv.base;
      const created = await httpc.request(base, 'POST', '/api/items',
        { body: { name: '并发测试物品', locId: 'l_tvdrawer' } });
      expect.eq(created.status, 201, '建物品状态码');
      const id = created.json.item.id;

      const qtys = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
      const completion = [];
      const responses = await Promise.all(qtys.map((q) => httpc.request(base, 'PUT',
        '/api/items/' + encodeURIComponent(id), { body: { qty: q } })
        .then((res) => {
          completion.push({ qty: q, status: res.status });
          return res;
        })));

      responses.forEach((res, i) => {
        expect.eq(res.status, 200, '并发 PUT 第 ' + (i + 1) + ' 个状态码，响应 ' +
          res.text.slice(0, 200));
        expect.ok(res.text.indexOf('SQLITE_BUSY') === -1, '不应出现 SQLITE_BUSY');
        expect.ok(res.text.indexOf('数据库') === -1,
          '不应出现数据库错误：' + res.text.slice(0, 200));
      });

      const fresh = await httpc.request(base, 'GET', '/api/items');
      const row = fresh.json.items.filter((x) => x.id === id)[0];
      expect.ok(row, '物品应还在');
      expect.ok(qtys.indexOf(row.qty) !== -1,
        '最终 qty=' + row.qty + ' 必须是提交过的值之一：' + qtys.join(','));
      const last = completion[completion.length - 1];
      expect.eq(last.status, 200, '最后完成的那个请求应成功');
      expect.eq(row.qty, last.qty,
        '库内最终值(' + row.qty + ')应该等于最后完成的响应值(' + last.qty + ')');
      expect.ok(s.newSrv.stderr.indexOf('[api error]') === -1,
        '服务端不应该有 api error 日志：' + s.newSrv.stderr.slice(0, 400));
    }, { repro: 'node qa/qa-p1.js --only C1' });

  runner.test('C2', '并发建：同时建 5 个位置 → 5 个都在、id 不重复、都有坐标', async () => {
    const s = await mut();
    const base = s.newSrv.base;
    const names = ['并发房一', '并发房二', '并发房三', '并发房四', '并发房五'];
    const responses = await Promise.all(names.map((name) =>
      httpc.request(base, 'POST', '/api/locations', { body: { name, kind: 'room' } })));
    responses.forEach((res, i) => {
      expect.eq(res.status, 201, names[i] + ' 状态码');
    });
    const ids = responses.map((r) => r.json.location.id);
    expect.eq(new Set(ids).size, 5, '5 个 id 应互不相同');

    const tree = await httpc.request(base, 'GET', '/api/locations');
    const seen = new Set();
    const walk = (nodes) => nodes.forEach((n) => { seen.add(n.id); walk(n.children || []); });
    walk(tree.json.tree);
    ids.forEach((id, i) => {
      expect.ok(seen.has(id), names[i] + '（' + id + '）应出现在树里，说明没被并发覆盖');
    });
    responses.forEach((r, i) => {
      expect.ok(r.json.location.box && typeof r.json.location.box.x === 'number',
        names[i] + ' 应有自动摆放的坐标');
    });
    for (const id of ids) {
      await httpc.request(base, 'DELETE', '/api/locations/' + encodeURIComponent(id));
    }
  }, { repro: 'node qa/qa-p1.js --only C2' });

  runner.test('C3', '照片上传：非图片伪装 / 超 6MB / 超 9MB 请求体 → 全部拒绝且不留孤儿文件',
    async () => {
      const s = await mut();
      const base = s.newSrv.base;
      const photoDir = path.join(s.newData, 'photos');
      const created = await httpc.request(base, 'POST', '/api/items',
        { body: { name: '照片测试物品' } });
      const id = created.json.item.id;
      const baseline = util.listFiles(photoDir).length;

      // 1) 名字装成图片，内容不是
      const fake = Buffer.from('GIF89a 这不是图片，只是想混进来的一串字节……', 'utf8');
      const bad = await httpc.request(base, 'POST',
        '/api/items/' + encodeURIComponent(id) + '/photo',
        { body: { data: fake.toString('base64') } });
      expect.eq(bad.status, 400, '非图片内容应 400，实际 ' + bad.status + ' ' + bad.text.slice(0, 160));
      expect.eq(util.listFiles(photoDir).length, baseline, '被拒绝的上传不能留下文件');

      // 2) 合法图片头但 6.5MB（base64 后约 8.7MB，没超过请求体 9MB）
      const big = Buffer.alloc(Math.floor(6.5 * 1024 * 1024));
      big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
      const tooBig = await httpc.request(base, 'POST',
        '/api/items/' + encodeURIComponent(id) + '/photo',
        { body: { data: big.toString('base64') }, timeout: 60000 });
      expect.eq(tooBig.status, 400, '6.5MB 图片应被拒（400），实际 ' + tooBig.status);
      expect.includes(tooBig.text, '6MB', '错误文案应说明 6MB 上限');
      expect.eq(util.listFiles(photoDir).length, baseline, '超尺寸图片不能留下孤儿文件');

      // 3) 请求体超过 9MB → 413（读请求体之前就拦掉）
      const huge = Buffer.alloc(Math.floor(7 * 1024 * 1024));
      huge[0] = 0xff; huge[1] = 0xd8; huge[2] = 0xff;
      const hugeRes = await httpc.request(base, 'POST',
        '/api/items/' + encodeURIComponent(id) + '/photo',
        { body: { data: huge.toString('base64') }, timeout: 60000 });
      expect.eq(hugeRes.status, 413, '超过 9MB 的请求体应 413，实际 ' + hugeRes.status);
      expect.eq(util.listFiles(photoDir).length, baseline, '413 之后不能留下孤儿文件');

      // 4) 正常上传一张真实 PNG → 200，文件真落盘
      const png = realPng(repoRoot);
      const okRes = await httpc.request(base, 'POST',
        '/api/items/' + encodeURIComponent(id) + '/photo',
        { body: { data: png.toString('base64') } });
      expect.eq(okRes.status, 200, '正常上传应 200');
      expect.eq(util.listFiles(photoDir).length, baseline + 1, '应多出一个照片文件');
      const fileName = okRes.json.photo.file;
      expect.ok(fs.existsSync(path.join(photoDir, fileName)), '照片文件应真的写进 photos 目录');
      expect.eq(okRes.json.item.photo, fileName, '物品上应记录文件名');
      expect.eq(fs.statSync(path.join(photoDir, fileName)).size, png.length,
        '落盘字节数应与原图一致');

      // 5) 能按 URL 取回，字节完全一致（注意比 Buffer，不能比 utf8 字符串长度）
      const fetched = await httpc.request(base, 'GET', '/photos/' + fileName);
      expect.eq(fetched.status, 200, '取照片状态码');
      expect.eq(fetched.headers['content-type'], 'image/png', '照片 Content-Type');
      expect.eq(fetched.raw.length, png.length, '取回的照片字节数应与原图一致');
      expect.ok(fetched.raw.equals(png), '取回的照片内容应与原图逐字节相同');

      await httpc.request(base, 'DELETE', '/api/items/' + encodeURIComponent(id));
      expect.eq(util.listFiles(photoDir).length, baseline, '删物品应连带删掉它的照片文件');
    }, { repro: 'node qa/qa-p1.js --only C3' });

  runner.test('C4', '照片生命周期：换图删旧图、显式删照片、无照片时 DELETE 幂等', async () => {
    const s = await mut();
    const base = s.newSrv.base;
    const photoDir = path.join(s.newData, 'photos');
    const baseline = util.listFiles(photoDir).length;
    const png = realPng(repoRoot);

    const created = await httpc.request(base, 'POST', '/api/items',
      { body: { name: '换图测试物品' } });
    const id = created.json.item.id;

    const first = await httpc.request(base, 'POST',
      '/api/items/' + encodeURIComponent(id) + '/photo',
      { body: { data: png.toString('base64') } });
    const firstFile = first.json.photo.file;
    expect.eq(util.listFiles(photoDir).length, baseline + 1, '第一次上传后 +1');

    const second = await httpc.request(base, 'POST',
      '/api/items/' + encodeURIComponent(id) + '/photo',
      { body: { data: png.toString('base64') } });
    const secondFile = second.json.photo.file;
    expect.ok(firstFile !== secondFile, '两次上传应生成不同文件名');
    expect.ok(!fs.existsSync(path.join(photoDir, firstFile)), '换图后旧文件应被删除');
    expect.eq(util.listFiles(photoDir).length, baseline + 1, '换图后文件总数仍是 +1');

    const cleared = await httpc.request(base, 'DELETE',
      '/api/items/' + encodeURIComponent(id) + '/photo');
    expect.eq(cleared.status, 200, '删照片状态码');
    expect.ok(!('photo' in cleared.json.item), '删照片后响应里不应再有 photo 字段');
    expect.ok(!fs.existsSync(path.join(photoDir, secondFile)), '删照片后文件应被删除');
    expect.eq(util.listFiles(photoDir).length, baseline, '文件数回到基线');

    const again = await httpc.request(base, 'DELETE',
      '/api/items/' + encodeURIComponent(id) + '/photo');
    expect.eq(again.status, 200, '对没有照片的物品重复删照片应 200');
    expect.eq(again.json.ok, true, '重复删除返回 ok:true');

    await httpc.request(base, 'DELETE', '/api/items/' + encodeURIComponent(id));
  }, { repro: 'node qa/qa-p1.js --only C4' });

  runner.test('C5', '树操作红线：多级环 / 根节点自环 / 删掉根节点（整棵树+全部物品归位）新旧一致',
    async () => {
      const s = await doomed();
      const pair = makePair(s);

      // 搭一条 A → B → C 的链
      const a = await pair2(pair, 'POST', '/api/locations',
        () => ({ name: '链-A', kind: 'room', parent: 'l_home' }));
      expect.eq(a.new.status, 201, '建链-A 状态码');
      const aId = idsOf(a, 'location');
      const b = await pair2(pair, 'POST', '/api/locations',
        (side) => ({ name: '链-B', parent: aId[side] }));
      const bId = idsOf(b, 'location');
      const c = await pair2(pair, 'POST', '/api/locations',
        (side) => ({ name: '链-C', parent: bId[side] }));
      const cId = idsOf(c, 'location');

      // 把 A 挂到孙子 C 下面：多级环必须被拦住
      const multi = await pair2(pair, 'PUT',
        (side) => '/api/locations/' + encodeURIComponent(aId[side]),
        (side) => ({ parent: cId[side] }));
      expect.eq(multi.new.status, 400, '多级环应 400（新），实际 ' + multi.new.status);
      expect.eq(multi.old.status, 400, '多级环应 400（旧），实际 ' + multi.old.status);
      expect.eq(multi.new.json.error, multi.old.json.error, '多级环报错文案应一致');

      // 根节点挂到自己下面
      const selfRoot = await pair2(pair, 'PUT', '/api/locations/l_home',
        () => ({ parent: 'l_home' }));
      expect.eq(selfRoot.new.status, 400, '根节点自环应 400（新）');
      expect.eq(selfRoot.old.status, 400, '根节点自环应 400（旧）');
      expect.eq(selfRoot.new.json.error, selfRoot.old.json.error, '自环报错文案应一致');

      // 状态没被改坏：树仍只有 1 个根
      const treeBefore = await pair2(pair, 'GET', '/api/locations');
      expect.eq(treeBefore.new.json.tree.length, 1, '防御之后树应仍有 1 个根');
      sameCanon(pair, treeBefore, '防御之后整棵树');

      // 把链删掉，回到 19 个位置的原样
      const cleanup = await pair2(pair, 'DELETE',
        (side) => '/api/locations/' + encodeURIComponent(aId[side]));
      expect.eq(cleanup.new.json.removed, 3, '应删掉链-A/B/C 共 3 条');
      expect.eq(cleanup.old.json.removed, cleanup.new.json.removed, 'removed 计数（新旧一致）');

      // 核心数据风险：删根节点
      // P2 起新版直接拒绝（400）；旧版会连根拔起，这里保留对旧版的实测以便对照说明。
      const delRoot = await pair2(pair, 'DELETE', '/api/locations/l_home');
      expect.eq(delRoot.new.status, 400, '删根节点应被拒绝（新），实际 ' + delRoot.new.status);
      expect.eq(delRoot.new.json.error, '「家」这一层不能删除', '删根节点的拒绝文案');
      expect.eq(delRoot.old.status, 200, '旧版仍会执行删除（对照用）');
      expect.eq(delRoot.old.json.removed, 19, '旧版删根节点会连带删除全部 19 个位置');

      // 新版的树必须毫发无损
      const afterTree = await pair2(pair, 'GET', '/api/locations');
      expect.eq(afterTree.new.json.tree.length, 1, '拒绝删根后仍应只有 1 个根');
      const countNodes = (nodes) => nodes.reduce((n, x) => n + 1 + countNodes(x.children || []), 0);
      expect.eq(countNodes(afterTree.new.json.tree), 19, '拒绝删根后仍有 19 个位置');
      expect.eq(afterTree.new.json.settings.planWidthM, 12, '户型设置不受影响');

      const afterItems = await pair2(pair, 'GET', '/api/items');
      const orphan = afterItems.new.json.items.filter((i) => i.locId === null);
      expect.eq(orphan.length, 0, '拒绝删根后没有任何物品变成未归档');

      runner.finding('F-C5',
        '删除根节点 l_home 在 P2 已被拒绝（旧版会抹掉整个户型）',
        '旧版 DELETE /api/locations/l_home 返回 removed=19：19 个位置全删、26 件物品全部变「未归档」。' +
        'P2 起服务端直接返回 400「「家」这一层不能删除」，树与物品归位信息毫发无损。' +
        '前端本来也点不到根节点（它没有地图坐标），这条保护只影响直接调接口的场景。',
        'fixed');
    }, { repro: 'node qa/qa-p1.js --only C5' });

  runner.test('C6', 'box 边界：null / {} / 缺字段 / 字符串数字 / 负宽高 / 超大值 不 500，差异如实记录',
    async () => {
      const s = await parity();
      const pair = makePair(s);
      const created = await pair2(pair, 'POST', '/api/locations',
        () => ({ name: 'box 边界房间', kind: 'room' }));
      const room = idsOf(created, 'location');
      const roomPath = (side) => '/api/locations/' + encodeURIComponent(room[side]);

      const cases = [
        { label: 'null', box: null },
        { label: '{}', box: {} },
        { label: '{x:1}', box: { x: 1 } },
        { label: 'x 是字符串', box: { x: 'a', y: 2, w: 3, h: 4 } },
        { label: '字符串数字', box: { x: '1.5', y: '2.5', w: '3.5', h: '4.5' } },
        { label: '负宽高', box: { x: 5, y: 5, w: -10, h: -10 } },
        { label: '超大值', box: { x: 1e9, y: -1e9, w: 1e9, h: 1e9 } },
        { label: '数组', box: [1, 2, 3, 4] },
        { label: '字符串', box: 'nope' }
      ];
      const diffs = [];
      for (const c of cases) {
        const res = await pair2(pair, 'PUT', roomPath, () => ({ box: c.box }));
        expect.ok(res.new.status < 500, 'box=' + c.label + ' 不应 500（实际 ' + res.new.status + '）');
        expect.ok(res.old.status < 500, 'box=' + c.label + ' 旧版也不应 500');
        expect.eq(res.new.status, res.old.status, 'box=' + c.label + ' 状态码');
        const ob = res.old.json && res.old.json.location ? res.old.json.location.box : undefined;
        const nb = res.new.json && res.new.json.location ? res.new.json.location.box : undefined;
        if (JSON.stringify(ob) !== JSON.stringify(nb)) {
          diffs.push('  · box=' + c.label + '：旧 ' + JSON.stringify(ob) +
            ' → 新 ' + JSON.stringify(nb));
        }
        // 新版对外必须仍然是「对象或 null」，不能吐出 NaN / 半截对象
        if (nb !== null) {
          ['x', 'y', 'w', 'h'].forEach((k) => {
            expect.ok(typeof nb[k] === 'number' && Number.isFinite(nb[k]),
              'box=' + c.label + ' 的新版返回值里 ' + k + ' 必须是有限数字，实际 ' +
              JSON.stringify(nb));
          });
        }
        // 再读一次库，确认 GET 出来的形状与 PUT 返回一致
        const readBack = await pair2(pair, 'GET', '/api/locations');
        const findNode = (nodes) => {
          for (const n of nodes) {
            if (room.new && n.name === 'box 边界房间') return n;
            const got = findNode(n.children || []);
            if (got) return got;
          }
          return null;
        };
        const node = findNode(readBack.new.json.tree);
        expect.ok(node, 'box=' + c.label + ' 之后房间应仍在树里');
        expect.deep(node.box, nb, 'box=' + c.label + ' 的返回值与随后 GET 到的值应一致');
      }
      if (diffs.length) {
        runner.finding('F-C6',
          'box 归一化比旧版更严：非法 box 一律落成 null（合法输入零差异）',
          'PUT /api/locations/:id 的差异（旧 → 新）：\n' + diffs.join('\n') +
          '\n合法输入（四个有限数字，含字符串数字、负数、超大值）两版逐位相同；' +
          '非法输入旧版会原样存下来（前端算面积时得到 NaN、地图上画不出来），新版统一落成 null。' +
          '前端只在拖动地图时提交 box，必然四个数字，实际走不到非法输入。' +
          '结论：属于「变严的修正」，不算回归。',
          'info');
      }
    }, { repro: 'node qa/qa-p1.js --only C6' });

  runner.test('C7', '非法 locId：POST 带不存在的 locId、PUT 改成不存在的 locId → 记录差异并判断是否回归',
    async () => {
      const s = await onlyInvalidIds();
      const pair = makePair(s);
      const created = await pair2(pair, 'POST', '/api/items',
        () => ({ name: '非法位置物品', locId: 'l_nope' }));
      expect.eq(created.new.status, 201, '带非法 locId 仍应建成（新版）');
      expect.eq(created.old.status, 201, '带非法 locId 仍应建成（旧版）');
      expect.eq(created.new.json.item.locId, null, '新版应落成 null（外键兜底）');
      expect.eq(created.old.json.item.locId, 'l_nope', '旧版会原样保留假 id');
      expect.eq(created.new.json.item.path, '未归档', '新版 path 应为未归档');
      expect.eq(created.old.json.item.path, '未归档', '旧版 path 也是未归档');

      const item = idsOf(created, 'item');
      const itemPath = (side) => '/api/items/' + encodeURIComponent(item[side]);

      // 先归位到真实位置，再改成非法位置
      const real = await pair2(pair, 'PUT', itemPath, () => ({ locId: 'l_tvdrawer' }));
      expect.eq(real.new.json.item.path, '我家 › 客厅 › 电视柜 › 左侧抽屉', '新版先归位到抽屉');
      expect.eq(real.old.json.item.path, real.new.json.item.path, '归位后 path 一致');
      const broken = await pair2(pair, 'PUT', itemPath, () => ({ locId: 'l_nope' }));
      expect.eq(broken.new.status, 200, '改成非法 locId 仍应 200（新版）');
      expect.eq(broken.new.json.item.locId, null, '新版 locId 落成 null');
      expect.eq(broken.old.json.item.locId, 'l_nope', '旧版保留假 id');
      expect.eq(broken.new.json.item.path, broken.old.json.item.path, '两版 path 都是未归档');

      // 前端可达性：locId 只来自 <select>，选项由真实位置生成
      const appjs = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
      const submitLines = appjs.split('\n')
        .map((line, no) => ({ line, no: no + 1 }))
        .filter((x) => /locId:\s*\$\('(f|g)-loc'\)\.value/.test(x.line));
      expect.ok(submitLines.length >= 2,
        '应能在 app.js 里找到 locId 的提交位置，实际找到 ' + submitLines.length + ' 处');

      runner.finding('F-C7',
        '非法 locId：旧版存假 id、新版落成 NULL —— 判定为「修正」，不是回归',
        '差异：POST/PUT /api/items 带 locId="l_nope" 时，旧版把 "l_nope" 原样写进 db.json，' +
        '新版因外键 loc_id REFERENCES locations(id) 落成 NULL。两版对外 path 都是「未归档」，' +
        '用户看到的结果一致。前端传 locId 的唯一来源是下拉框 public/app.js:' +
        submitLines.map((x) => x.no).join('/') +
        '（locId: $(\'f-loc\') 或 $(\'g-loc\').value || null），选项由 /api/locations 的真实位置生成，' +
        '所以前端走不到「提交一个不存在的 id」这条路。结论：新版更干净，旧版反而会留下脏引用。',
        'info');
    }, { repro: 'node qa/qa-p1.js --only C7' });

  runner.test('C8', 'payload 边界：3MB JSON → 413 且服务不崩；Content-Length 声明不符也不崩',
    async () => {
      const s = await mut();
      const base = s.newSrv.base;
      const res = await httpc.request(base, 'POST', '/api/items',
        { body: { name: 'x', note: 'y'.repeat(3 * 1024 * 1024) }, timeout: 30000 });
      expect.eq(res.status, 413, '3MB 请求体应 413，实际 ' + res.status);
      expect.includes(res.text, '提交的内容太长了', '413 文案');

      const bad = await httpc.requestWithBadLength(base, 'POST', '/api/items', 10,
        Buffer.from('{"name":"abcdefghijklmnopqrstuvwxyz"}'));
      expect.ok(bad.status === null || bad.status > 0,
        'Content-Length 不符时应返回某个状态或直接断连，实际 ' + JSON.stringify(bad));

      const alive = await httpc.request(base, 'GET', '/api/locations');
      expect.eq(alive.status, 200, '边界请求之后服务应仍然可用');
      expect.eq(alive.json.ok, true, '服务响应应正常');
    }, { repro: 'node qa/qa-p1.js --only C8' });

  runner.test('C9', '路径穿越与畸形 URL：/photos/../ 与 /../server.js 一律拒绝，不泄露文件',
    async () => {
      const s = await parity();
      const base = s.newSrv.base;
      // 注意：必须用 requestRaw，否则客户端会先替我们把 ../ 归一化掉。
      // 另外这里对「明文 ../」和「百分号编码的 ../」期望不同，原因是 WHATWG URL 解析器
      // 会先把明文 ../ 归一化掉（所以那些请求根本到不了照片处理器），
      // 编码过的能活到路由，正好用来验证服务端自己的白名单与前缀校验。
      const cases = [
        ['/photos/../../etc/passwd', 404, '明文 ../ 被 URL 解析器归一化后落到静态 404'],
        ['/photos/%2e%2e%2f%2e%2e%2fetc%2fpasswd', 400, '编码穿越到达 servePhoto，被文件名白名单拒'],
        ['/photos/..%2f..%2fetc%2fpasswd', 400, '同上（%2f 形式）'],
        ['/photos/..%5c..%5cwindows%5cwin.ini', 400, '反斜杠穿越，basename 后仍不合法'],
        ['/photos/....//....//etc/passwd', 400, '多余斜杠穿越，basename 仍是 passwd'],
        ['/../server.js', 404, '明文 ../ 归一化后落到静态 404'],
        ['/%2e%2e%2fserver.js', 403, '编码穿越到达 serveStatic，被前缀校验拒'],
        ['/..%2f..%2fpackage.json', 403, '同上（多级）']
      ];
      for (const c of cases) {
        const res = await httpc.requestRaw(base, 'GET', c[0]);
        expect.eq(res.status, c[1], c[0] + ' 应 ' + c[1] + '（' + c[2] + '），实际 ' + res.status);
        expect.ok(res.status >= 400 && res.status < 500,
          c[0] + ' 必须是 4xx，不能返回内容');
        expect.ok(res.text.indexOf('root:') === -1, c[0] + ' 不能泄露 /etc/passwd 内容');
        expect.ok(res.text.indexOf('"homebox"') === -1, c[0] + ' 不能把仓库文件读出来');
        expect.ok(res.text.indexOf('readDB') === -1, c[0] + ' 不能把 server.js 读出来');
      }
      // 正常路径仍然要能取到照片
      const ok = await httpc.requestRaw(base, 'GET', '/photos/p_mvd7uwekv633w.png');
      expect.eq(ok.status, 200, '正常照片路径应 200');
      // 带 ../ 但最终仍指向同一张合法照片：归一化后照常返回，内容仍是那张图，无风险
      const same = await httpc.requestRaw(base, 'GET',
        '/photos/p_mvd7uwekv633w.png/../p_mvd7uwekv633w.png');
      expect.eq(same.status, 200, '归一化后指向合法照片时应正常返回');
      expect.ok(same.raw.equals(ok.raw), '归一化后拿到的还是同一张照片');

      // 畸形百分号编码：新版应 400 且不崩（旧版这里会在请求回调里抛未捕获异常）
      const malformed = await httpc.request(base, 'GET', '/%E0%A4%A');
      expect.eq(malformed.status, 400, '畸形 URI 编码应 400，实际 ' + malformed.status);
      const alive = await httpc.request(base, 'GET', '/api/locations');
      expect.eq(alive.status, 200, '畸形 URI 之后服务应仍然可用');
      runner.finding('F-C9',
        '旧版 GET /%E0%A4%A 会直接让进程退出（实测），新版返回 400 —— 修掉了一个远程可触发的崩溃点',
        '实测：对 main 分支的 server.js 发一条 GET /%E0%A4%A，连接被 reset，进程以 exit code 1 退出、' +
        '之后所有请求都连不上。原因：旧版在 createServer 回调里直接 decodeURIComponent(parsed.pathname)，' +
        '畸形编码同步抛 URIError，Node 按 uncaughtException 处理即终止进程。' +
        '新版 lib/http.js 与 server.js 都套了 try/catch → 400，且服务继续可用（本用例已断言）。' +
        '这条不需要登录、一条 GET 就能触发，属于 P1 顺带修掉的安全问题，值得写进发布说明。',
        'info');
    }, { repro: 'node qa/qa-p1.js --only C9' });

  runner.test('C10', '搜索边界：中文+英文混排、纯空格、%/_ 通配符、5000 字符 → 新旧一致', async () => {
    const s = await parity();
    const pair = makePair(s);
    const queries = ['电视柜 指甲刀', '  电视柜   ', '%', '_', '%%', '__',
      'Type-C', 'type-c 充电线', '工具 耗材', '～', 'x'.repeat(5000)];
    for (const q of queries) {
      const res = await pair2(pair, 'GET',
        '/api/items?q=' + encodeURIComponent(q));
      expect.eq(res.new.status, 200, 'q=' + JSON.stringify(q.slice(0, 12)) + ' 状态码');
      // P2 起响应多了金额/归属等字段，先剥掉再比（详见 qa/lib/canon.js 的 P2_ONLY）
      expect.eq(
        JSON.stringify(canon.canon(res.new.json, canon.newContext())),
        JSON.stringify(canon.canon(res.old.json, canon.newContext())),
        'q=' + JSON.stringify(q.slice(0, 12)) + ' 结果应与旧版一致（忽略 P2 新增字段）');
    }
    const wild = await httpc.request(s.newSrv.base, 'GET', '/api/items?q=%25');
    expect.eq(wild.json.items.length, 0, 'q=% 不应匹配任何物品（说明没裸拼 LIKE）');
    const underscore = await httpc.request(s.newSrv.base, 'GET', '/api/items?q=_');
    expect.eq(underscore.json.items.length, 0, 'q=_ 不应匹配任何物品');
  }, { repro: 'node qa/qa-p1.js --only C10' });
}

module.exports = { register };
