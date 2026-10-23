#!/usr/bin/env node
'use strict';

// HomeBox P2（身份 / 角色 / 金额 / 价值统计）验收测试
//
//   node qa/qa-p2.js            跑全部
//   node qa/qa-p2.js --only C   只跑 C 组
//
// 约束与 qa-p1 一致：
//   1. 真实 data/ 只读，跑前后各拍一次快照，变了就判本次测试无效；
//   2. 所有写操作发生在临时目录 + 随机端口里；
//   3. 不修改任何业务代码。

const fs = require('fs');
const os = require('os');
const path = require('path');


const util = require('./lib/util');
const httpc = require('./lib/httpc');
const servers = require('./lib/servers');

const REPO = util.REPO_ROOT;

let pass = 0;
let fail = 0;
const failures = [];
let currentCase = '';

/**
 * 断言相等。
 * @param {*} actual 实际值
 * @param {*} expected 期望值
 * @param {string} label 说明
 */
function eq(actual, expected, label) {
  if (actual === expected) {
    pass += 1;
    return;
  }
  fail += 1;
  failures.push(currentCase + ' · ' + label + '\n    期望：' + JSON.stringify(expected) +
    '\n    实际：' + JSON.stringify(actual));
}

/**
 * 断言为真。
 * @param {boolean} cond 条件
 * @param {string} label 说明
 * @param {string} [detail] 失败时的补充
 */
function ok(cond, label, detail) {
  if (cond) {
    pass += 1;
    return;
  }
  fail += 1;
  failures.push(currentCase + ' · ' + label + (detail ? '\n    ' + detail : ''));
}

/**
 * 取 Set-Cookie 里的第一个键值。
 * @param {object} headers 响应头
 * @returns {string|null}
 */
function cookieOf(headers) {
  const raw = headers['set-cookie'];
  if (!raw || !raw.length) return null;
  const first = raw[0].split(';')[0];
  if (!first || first.indexOf('=') === -1) return null;
  return first;
}

/**
 * 建一个带 Cookie 罐的客户端。
 * @param {string} base 基地址
 * @returns {object} 客户端
 */
function client(base) {
  const jar = {};
  return {
    jar,
    /**
     * 发请求。
     * @param {string} method 方法
     * @param {string} urlPath 路径
     * @param {object} [opts] 选项
     * @returns {Promise<object>} 响应
     */
    async req(method, urlPath, opts) {
      const cfg = opts || {};
      const headers = Object.assign({}, cfg.headers || {});
      if (cfg.who && jar[cfg.who]) headers.Cookie = jar[cfg.who];
      const res = await httpc.request(base, method, urlPath,
        { headers, body: cfg.body, timeout: 10000 });
      const cookie = cookieOf(res.headers);
      if (cookie && cfg.who) jar[cfg.who] = cookie;
      return res;
    }
  };
}

/**
 * 造一件物品（管理员身份）。
 * @param {object} api 客户端
 * @param {object} payload 入参
 * @returns {Promise<object>} item
 */
async function newItem(api, payload) {
  const res = await api.req('POST', '/api/items',
    { who: 'admin', body: Object.assign({ name: 'P2 测试物' }, payload) });
  if (!res.json || !res.json.item) {
    throw new Error('建物品失败：' + res.status + ' ' + res.text.slice(0, 200));
  }
  return res.json.item;
}

/**
 * 主流程。
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const only = (process.argv.indexOf('--only') !== -1)
    ? String(process.argv[process.argv.indexOf('--only') + 1] || '') : '';

  const wanted = (group) => !only || only === group || only.indexOf(group) === 0;

  // 真实数据快照
  const watchers = [
    path.join(REPO, 'data', 'homebox.db'),
    path.join(REPO, 'data', 'homebox.db-wal'),
    path.join(REPO, 'data', 'db.json.migrated'),
    path.join(REPO, 'data', 'db.pre-p1.json.bak')
  ];
  const photosDir = path.join(REPO, 'data', 'photos');
  const photoFiles = util.listFiles(photosDir).map((n) => path.join(photosDir, n));
  const before = util.snapshotFiles(watchers.concat(photoFiles));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-p2-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'data', 'homebox.db'), path.join(dataDir, 'homebox.db'));
  util.copyDir(photosDir, path.join(dataDir, 'photos'));

  const srv = await servers.startNewServer({ repoRoot: REPO, dataDir });
  const api = client(srv.base);

  try {
    /* ================= A 初始化与身份 ================= */
    if (wanted('A')) {
      currentCase = 'A1 首次使用（无成员）按管理员对待';
      const me0 = await api.req('GET', '/api/auth/me', { who: 'admin' });
      eq(me0.status, 200, '状态码');
      eq(me0.json.needSetup, true, 'needSetup=true');
      eq(me0.json.bootstrap, true, 'bootstrap=true');
      eq(me0.json.me.role, 'admin', '首次使用按管理员');
      eq(me0.json.caps.seePrice, true, '首次使用能看金额');

      currentCase = 'A2 建管理员';
      const setup = await api.req('POST', '/api/auth/setup',
        { who: 'admin', body: { name: '老王', password: 'home123456' } });
      eq(setup.status, 201, '状态码');
      eq(setup.json.member.role, 'admin', '角色是 admin');
      eq(setup.json.member.hasPassword, true, '设了密码');
      ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(setup.json.recoverCode || ''),
        '恢复码是 8 位分组格式', '实际：' + setup.json.recoverCode);

      const me1 = await api.req('GET', '/api/auth/me', { who: 'admin' });
      eq(me1.json.needSetup, false, '初始化后 needSetup=false');
      eq(me1.json.me.name, '老王', '当前身份正确');
      eq(me1.json.members.length, 1, '成员列表 1 人');

      currentCase = 'A3 重复初始化被拒';
      const again = await api.req('POST', '/api/auth/setup',
        { who: 'admin', body: { name: '第二个管理员', password: '123456' } });
      eq(again.status, 409, '状态码');

      currentCase = 'A4 未登录访问';
      const anon = await api.req('GET', '/api/auth/me');
      eq(anon.json.me, null, 'me 为 null');
      eq(anon.json.needSetup, false, '已初始化');
      eq(anon.json.members.length, 1, '未登录也能看到成员名单（点头像登录要用）');
      ok(!JSON.stringify(anon.json).includes('pass_hash'), '响应里不含密码哈希');

      currentCase = 'A5 建成员 + 点人头登录';
      const m1 = await api.req('POST', '/api/members',
        { who: 'admin', body: { name: '小李', role: 'member' } });
      eq(m1.status, 201, '建成员状态码');
      eq(m1.json.member.role, 'member', '角色');
      eq(m1.json.recoverCode || null, null, '没设密码就没有恢复码');

      const login1 = await api.req('POST', '/api/auth/login',
        { who: 'member', body: { memberId: m1.json.member.id } });
      eq(login1.status, 200, '点人头登录状态码');
      eq(login1.json.me.name, '小李', '登录身份');

      currentCase = 'A6 管理员登录：密码错误 401 / 正确 200';
      const bad = await api.req('POST', '/api/auth/login',
        { who: 'x', body: { memberId: me1.json.me.id, password: 'wrong-pass' } });
      eq(bad.status, 401, '错密码');
      const good = await api.req('POST', '/api/auth/login',
        { who: 'admin2', body: { memberId: me1.json.me.id, password: 'home123456' } });
      eq(good.status, 200, '对密码');

      currentCase = 'A7 伪造 / 篡改 Cookie 无效';
      const fake = await httpc.request(srv.base, 'GET', '/api/auth/me', {
        headers: { Cookie: 'hb_sid=eyJtIjoibV94In0.deadbeef' }
      });
      eq(fake.json.me, null, '伪造签名被拒');

      currentCase = 'A8 改密码后旧 Cookie 立即失效（pass_ver）';
      const stillGood = await api.req('GET', '/api/auth/me', { who: 'admin2' });
      eq(stillGood.json.me.name, '老王', '改密码前有效');
      const reset = await api.req('POST', '/api/members/' + encodeURIComponent(me1.json.me.id) + '/password',
        { who: 'admin', body: { password: 'newpass123' } });
      eq(reset.status, 200, '改密码状态码');
      const after = await api.req('GET', '/api/auth/me', { who: 'admin2' });
      eq(after.json.me, null, '旧 Cookie 已失效');

      // 旧 Cookie 失效是预期行为，后面的用例得用新密码重新登录
      const relogin = await api.req('POST', '/api/auth/login',
        { who: 'admin', body: { memberId: me1.json.me.id, password: 'newpass123' } });
      eq(relogin.status, 200, '用新密码重新登录');
    }

    // 后续组都要有管理员身份
    if (!api.jar.admin) {
      await api.req('POST', '/api/auth/login',
        { who: 'admin', body: { memberId: (await api.req('GET', '/api/auth/me')).json.members[0].id, password: 'home123456' } });
    }

    /* ================= B 角色权限 ================= */
    if (wanted('B')) {
      currentCase = 'B1 访客：能看不能改，看不到钱';
      const g = await api.req('POST', '/api/members',
        { who: 'admin', body: { name: '客人', role: 'guest' } });
      const gid = g.json.member.id;
      await api.req('POST', '/api/auth/login', { who: 'guest', body: { memberId: gid } });

      const list = await api.req('GET', '/api/items', { who: 'guest' });
      eq(list.status, 200, 'GET items 允许');
      const anyItem = list.json.items[0];
      ok(!('priceCents' in anyItem), '访客响应里没有 priceCents 这个 key',
        '实际存在：' + Object.keys(anyItem).join(','));
      ok(!('valueCents' in anyItem), '访客响应里没有 valueCents');

      const post = await api.req('POST', '/api/items',
        { who: 'guest', body: { name: '访客乱记' } });
      eq(post.status, 403, '访客不能新建');
      const del = await api.req('DELETE', '/api/items/' + encodeURIComponent(anyItem.id), { who: 'guest' });
      eq(del.status, 403, '访客不能删除');
      const st = await api.req('GET', '/api/stats/value', { who: 'guest' });
      eq(st.status, 403, '访客不能看统计');
      const mem = await api.req('GET', '/api/members', { who: 'guest' });
      eq(mem.status, 403, '访客不能看成员管理');

      currentCase = 'B2 精简档：能记不能删，看不到钱';
      const s = await api.req('POST', '/api/members',
        { who: 'admin', body: { name: '爷爷', role: 'simple' } });
      await api.req('POST', '/api/auth/login', { who: 'simple', body: { memberId: s.json.member.id } });
      const sPost = await api.req('POST', '/api/items',
        { who: 'simple', body: { name: '精简档记的', price: 12 } });
      eq(sPost.status, 201, '精简档能新建');
      ok(!('priceCents' in sPost.json.item), '精简档看不到自己填的价格（服务端裁剪）');
      const sDel = await api.req('DELETE', '/api/items/' + encodeURIComponent(sPost.json.item.id), { who: 'simple' });
      eq(sDel.status, 403, '精简档不能删除');
      const sStats = await api.req('GET', '/api/stats/value', { who: 'simple' });
      eq(sStats.status, 403, '精简档不能看统计');

      currentCase = 'B3 成员：能删能看钱，不能管人';
      const target = await newItem(api, { name: '成员要删的东西' });
      const mDel = await api.req('DELETE', '/api/items/' + encodeURIComponent(target.id), { who: 'member' });
      eq(mDel.status, 200, '成员能删除');
      const mMembers = await api.req('GET', '/api/members', { who: 'member' });
      eq(mMembers.status, 403, '成员不能管人');

      currentCase = 'B4 最后一个管理员不能被降级/删除';
      const onlyAdmin = (await api.req('GET', '/api/auth/me', { who: 'admin' })).json.members
        .find((x) => x.role === 'admin');
      const demote = await api.req('PUT', '/api/members/' + encodeURIComponent(onlyAdmin.id),
        { who: 'admin', body: { role: 'member' } });
      eq(demote.status, 400, '降级被拒');
      const delAdmin = await api.req('DELETE', '/api/members/' + encodeURIComponent(onlyAdmin.id),
        { who: 'admin' });
      eq(delAdmin.status, 400, '删除被拒');

      currentCase = 'B5 未登录（无 Cookie）只能是访客';
      const anonPost = await api.req('POST', '/api/items', { body: { name: '匿名乱记' } });
      eq(anonPost.status, 403, '未登录不能写');
    }

    /* ================= C 金额与统计 ================= */
    if (wanted('C')) {
      currentCase = 'C1 元 → 分，且 valueCents = 单价 × 数量';
      const item = await newItem(api, {
        name: 'C1 电钻', qty: 2, price: 199.9, buyDate: '2026-01-05', category: '工具'
      });
      eq(item.priceCents, 19990, '199.9 元 = 19990 分');
      eq(item.valueCents, 39980, '两件小计');
      eq(item.category, '工具', '类目');
      eq(item.buyDate, '2026-01-05', '购入日期');

      currentCase = 'C2 边界：0 元 ≠ 未填；负数/非数字当未填';
      const zero = await newItem(api, { name: 'C2 零元', price: 0 });
      eq(zero.priceCents, 0, '0 元存成 0 分，不是 null');
      const neg = await newItem(api, { name: 'C2 负数', price: -5 });
      eq(neg.priceCents, null, '负数当未填');
      const nan = await newItem(api, { name: 'C2 非数字', price: 'abc' });
      eq(nan.priceCents, null, '非数字当未填');
      const none = await newItem(api, { name: 'C2 未填' });
      eq(none.priceCents, null, '不填就是 null');

      currentCase = 'C3 清空价格：PUT price=null';
      const cleared = await api.req('PUT', '/api/items/' + encodeURIComponent(item.id),
        { who: 'admin', body: { price: null } });
      eq(cleared.json.item.priceCents, null, '可以改回未记录');
      await api.req('PUT', '/api/items/' + encodeURIComponent(item.id),
        { who: 'admin', body: { price: 100 } });
      const restored = await api.req('GET', '/api/items?q=' + encodeURIComponent('C1 电钻'), { who: 'admin' });
      eq(restored.json.items[0].priceCents, 10000, '再改回 100 元');

      currentCase = 'C4 覆盖率与两个口径';
      const st = await api.req('GET', '/api/stats/value?by=loc', { who: 'admin' });
      eq(st.status, 200, '状态码');
      eq(st.json.currency, 'CNY', '单币种');
      const t = st.json.totals;
      eq(t.count - t.recorded, t.unrecorded, '未记录 = 总数 - 已记录');
      ok(t.recorded > 0, '至少有一件记了价', 'recorded=' + t.recorded);
      ok(t.allCents >= t.inUseCents, '累计购入 ≥ 在库价值');

      currentCase = 'C5 丢弃的物品不进「在库价值」，但进「累计购入」';
      const gone = await newItem(api, { name: 'C5 已丢弃', price: 50, qty: 1 });
      const stBefore = (await api.req('GET', '/api/stats/value', { who: 'admin' })).json.totals;
      await api.req('PUT', '/api/items/' + encodeURIComponent(gone.id),
        { who: 'admin', body: { state: 'discarded' } });
      const stAfter = (await api.req('GET', '/api/stats/value', { who: 'admin' })).json.totals;
      eq(stBefore.inUseCents - stAfter.inUseCents, 5000, '在库价值减少 50 元');
      eq(stBefore.allCents, stAfter.allCents, '累计购入不变');

      currentCase = 'C6 三个维度都能出数且排序合理';
      const byCat = (await api.req('GET', '/api/stats/value?by=category', { who: 'admin' })).json;
      ok(byCat.groups.some((g) => g.key === '工具'), '类目维度含「工具」');
      const byOwner = (await api.req('GET', '/api/stats/value?by=owner', { who: 'admin' })).json;
      ok(byOwner.groups.length >= 1, '成员维度非空');
      ok(byOwner.groups.every((g, i, arr) => i === 0 || arr[i - 1].valueCents >= g.valueCents),
        '按金额降序');
      const byLoc = (await api.req('GET', '/api/stats/value?by=loc', { who: 'admin' })).json;
      const groupSum = byLoc.groups.reduce((s, g) => s + g.valueCents, 0);
      eq(groupSum, byLoc.totals.allCents, '各分组金额之和 = 累计购入（不重不漏）');
      ok(byLoc.groups.some((g) => g.name === '未归档'),
        '没有位置的东西归到「未归档」，仍然计入金额');

      currentCase = 'C7 位置树节点带 valueCents，访客拿不到';
      const treeAdmin = await api.req('GET', '/api/locations', { who: 'admin' });
      const findRoom = (nodes, name) => {
        for (const n of nodes) {
          if (n.name === name) return n;
          const hit = findRoom(n.children || [], name);
          if (hit) return hit;
        }
        return null;
      };
      const living = findRoom(treeAdmin.json.tree, '客厅');
      ok(living && typeof living.valueCents === 'number', '客厅节点有 valueCents',
        '实际：' + (living && living.valueCents));
      const treeGuest = await api.req('GET', '/api/locations', { who: 'guest' });
      ok(treeGuest.json.tree.every((n) => !('valueCents' in n)), '访客拿不到节点金额');

      currentCase = 'C8 归属人：默认记在当前人名下';
      const owned = await newItem(api, { name: 'C8 归属测试' });
      const meAdmin = (await api.req('GET', '/api/auth/me', { who: 'admin' })).json.me;
      eq(owned.ownerId, meAdmin.id, '默认归属是当前登录人');
      const shared = await newItem(api, { name: 'C8 共用', ownerId: null });
      eq(shared.ownerId, null, '可以指定共用');
    }

    /* ================= D 数据安全 ================= */
    if (wanted('D')) {
      currentCase = 'D1 根位置禁止删除';
      const delRoot = await api.req('DELETE', '/api/locations/l_home', { who: 'admin' });
      eq(delRoot.status, 400, '状态码');
      const tree = await api.req('GET', '/api/locations', { who: 'admin' });
      eq(tree.json.tree.length, 1, '树还在');

      currentCase = 'D2 删房间仍然正常：物品落成未归档';
      const room = await api.req('POST', '/api/locations',
        { who: 'admin', body: { name: 'D2 临时房间', kind: 'room', parent: 'l_home' } });
      const rid = room.json.location.id;
      const inRoom = await newItem(api, { name: 'D2 房间里的东西', locId: rid });
      const delRoom = await api.req('DELETE', '/api/locations/' + encodeURIComponent(rid), { who: 'admin' });
      eq(delRoom.status, 200, '删房间');
      const after = await api.req('GET', '/api/items?q=' + encodeURIComponent('D2 房间里的东西'), { who: 'admin' });
      eq(after.json.items[0].locId, null, '物品落成未归档');
      eq(after.json.items[0].path, '未归档', '路径文案');
      ok(!!inRoom.id, '前置物品已建立');

      currentCase = 'D3 旧数据完好：26 件都在，state 默认在用';
      const all = await api.req('GET', '/api/items', { who: 'admin' });
      ok(all.json.items.length >= 26, '物品数不少', '实际 ' + all.json.items.length);
      const legacy = all.json.items.filter((i) => i.name === '指甲刀')[0];
      eq(legacy.state, 'in_use', '旧数据 state=in_use');
      eq(legacy.priceCents, null, '旧数据价格未知（不是 0）');

      currentCase = 'D4 照片接口受写权限保护';
      const photo = await api.req('POST', '/api/items/' + encodeURIComponent(legacy.id) + '/photo',
        { who: 'guest', body: { data: 'AAAA' } });
      eq(photo.status, 403, '访客不能传照片');
    }
  } finally {
    await servers.stopServer(srv);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
  }

  // 真实数据必须一字节未变
  const after = util.snapshotFiles(watchers.concat(photoFiles));
  const changed = util.diffSnapshot(before, after);

  console.log('');
  if (failures.length) {
    console.log('失败明细');
    console.log('────────────────────────────────────────');
    failures.forEach((f, i) => console.log((i + 1) + ') ' + f));
    console.log('');
  }
  console.log('测试报告');
  console.log('════════════════════════════════════════');
  console.log('断言数：' + (pass + fail) + '   通过：' + pass + '   失败：' + fail);
  console.log('真实数据未被改动：' + (changed.length ? '否！' + changed.join(',') : '是'));
  console.log('');

  if (changed.length) return 2;
  return fail ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error('[qa-p2] 崩了：' + (err && err.message));
  console.error(err && err.stack);
  process.exitCode = 3;
});
