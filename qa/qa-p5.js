'use strict';

// P5 验收：回收站（软删除）、并发编辑、登录限流、搜索语义、静态路径穿越
//
//   node qa/qa-p5.js            跑全部
//   node qa/qa-p5.js --only 回收  按关键字过滤
//
// 约束同 qa-p1/p2/p4：真实 data/ 只读（前后 sha256 快照比对），
// 一切写操作发生在临时目录 + 随机端口，跑完全清。
//
// 这一套不依赖「用户真实库里有几件东西」——它自己建自己删，
// 所以换一台机器、换一个家庭，结论都一样。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = require('./lib/util').REPO_ROOT;
const util = require('./lib/util');
const dbcheck = require('./lib/dbcheck');

/**
 * 发一个请求，返回 {status, headers, text, json}。
 * @param {string} base 服务地址
 * @param {string} method 方法
 * @param {string} urlPath 路径
 * @param {object} [opts] {body, cookie}
 * @returns {Promise<object>}
 */
function req(base, method, urlPath, opts) {
  const cfg = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(base + urlPath);
    const headers = Object.assign({}, cfg.headers || {});
    let payload = null;
    if (cfg.body !== undefined) {
      payload = Buffer.from(JSON.stringify(cfg.body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (cfg.cookie) headers.Cookie = cfg.cookie;
    const r = http.request({
      host: u.hostname, port: u.port, method, path: u.pathname + u.search, headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * 等服务起来。
 * @param {string} base 地址
 * @returns {Promise<boolean>}
 */
async function waitPort(base) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await req(base, 'GET', '/api/auth/me');
      if (r.status === 200) return true;
    } catch (e) { /* 等 */ }
    await new Promise((s) => setTimeout(s, 200));
  }
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx !== -1 ? String(argv[onlyIdx + 1] || '') : '';

  const before = util.snapshotRealData(REPO);
  const realDataDir = path.join(REPO, 'data');
  const countsBefore = dbcheck.logicalCounts(realDataDir);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-p5-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const port = 9500 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server.js')], {
      cwd: REPO,
      env: Object.assign({}, process.env, {
        PORT: String(port), HOST: '127.0.0.1', HB_DATA_DIR: dataDir, NODE_NO_WARNINGS: '1'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = 'http://127.0.0.1:' + port;
  if (!await waitPort(base)) {
    child.kill('SIGKILL');
    throw new Error('服务没起来\n' + log);
  }

  const out = [];
  const check = (l, c, d) => out.push((c ? 'PASS' : 'FAIL') + '  ' + l + (c ? '' : '  ← ' + (d || '')));
  const want = (name) => !only || name.indexOf(only) !== -1;

  const setup = await req(base, 'POST', '/api/auth/setup',
    { body: { name: '管理员', password: 'hb-p5-pass' } });
  const cookie = String(setup.headers['set-cookie'][0]).split(';')[0];

  /* ---------- 1. 回收站 ---------- */

  if (want('回收站')) {
    const made = await req(base, 'POST', '/api/items',
      { cookie, body: { name: '待删物品', qty: 3 } });
    const id = made.json.item.id;

    const del = await req(base, 'DELETE', '/api/items/' + encodeURIComponent(id), { cookie });
    // 返回体必须还是老的 {ok:true}：软删是内部实现，不该泄漏到契约里
    check('删除接口返回体保持 {ok:true}', del.status === 200 &&
      JSON.stringify(del.json) === '{"ok":true}', JSON.stringify(del.json));

    const list = await req(base, 'GET', '/api/items', { cookie });
    check('删掉的物品不在列表里', !(list.json.items || []).some((i) => i.id === id),
      '还能搜到 ' + id);

    const search = await req(base, 'GET', '/api/items?q=' + encodeURIComponent('待删物品'), { cookie });
    check('删掉的物品搜不到', (search.json.items || []).length === 0,
      JSON.stringify((search.json.items || []).map((i) => i.name)));

    const trash = await req(base, 'GET', '/api/trash', { cookie });
    const hit = (trash.json.items || []).filter((i) => i.id === id)[0];
    check('回收站里能看到它', !!hit, JSON.stringify(trash.json).slice(0, 120));
    check('回收站条目带删除时间', !!(hit && hit.deletedAt), JSON.stringify(hit && hit.deletedAt));
    check('回收站条目带原路径', !!(hit && hit.path), JSON.stringify(hit && hit.path));

    const again = await req(base, 'DELETE', '/api/items/' + encodeURIComponent(id), { cookie });
    check('重复删除 → 404（不在活列表里）', again.status === 404, String(again.status));

    const back = await req(base, 'POST', '/api/trash/' + encodeURIComponent(id) + '/restore', { cookie });
    check('恢复成功且 id 不变', back.status === 200 && back.json.item.id === id,
      JSON.stringify(back.json).slice(0, 120));
    check('恢复后数量还在', back.json.item.qty === 3, String(back.json.item.qty));

    const list2 = await req(base, 'GET', '/api/items', { cookie });
    check('恢复后回到列表', (list2.json.items || []).some((i) => i.id === id), '没找到');

    // 再删一次，走彻底删除
    await req(base, 'DELETE', '/api/items/' + encodeURIComponent(id), { cookie });
    const purge = await req(base, 'DELETE', '/api/trash/' + encodeURIComponent(id), { cookie });
    check('彻底删除成功', purge.status === 200 && purge.json.ok === true, JSON.stringify(purge.json));

    const trash2 = await req(base, 'GET', '/api/trash', { cookie });
    check('彻底删除后回收站里没有了',
      !(trash2.json.items || []).some((i) => i.id === id), '还在');

    const restoreGone = await req(base, 'POST',
      '/api/trash/' + encodeURIComponent(id) + '/restore', { cookie });
    check('彻底删除后无法恢复（404）', restoreGone.status === 404, String(restoreGone.status));
  }

  /* ---------- 2. 并发编辑 ---------- */

  if (want('并发')) {
    const made = await req(base, 'POST', '/api/items',
      { cookie, body: { name: '并发测试', qty: 1 } });
    const id = made.json.item.id;
    const v1 = made.json.item.updatedAt;

    const ok1 = await req(base, 'PUT', '/api/items/' + encodeURIComponent(id),
      { cookie, body: { qty: 2, baseUpdatedAt: v1 } });
    check('版本号正确时更新成功', ok1.status === 200 && ok1.json.item.qty === 2,
      JSON.stringify(ok1.json).slice(0, 120));
    const v2 = ok1.json.item.updatedAt;
    check('更新后版本号变了', v2 !== v1, v1 + ' → ' + v2);

    const stale = await req(base, 'PUT', '/api/items/' + encodeURIComponent(id),
      { cookie, body: { qty: 9, baseUpdatedAt: v1 } });
    check('拿旧版本号提交 → 409', stale.status === 409, String(stale.status));
    check('409 带 conflict 标记与最新内容',
      stale.json.conflict === true && !!(stale.json.current && stale.json.current.qty === 2),
      JSON.stringify(stale.json).slice(0, 160));

    const after = await req(base, 'GET', '/api/items?q=' + encodeURIComponent('并发测试'), { cookie });
    const row = (after.json.items || [])[0];
    check('409 时数据库没被覆盖', row && row.qty === 2, JSON.stringify(row && row.qty));

    const force = await req(base, 'PUT', '/api/items/' + encodeURIComponent(id),
      { cookie, body: { qty: 9, baseUpdatedAt: v2 } });
    check('用最新版本号再提交能成功（用户确认后可覆盖）',
      force.status === 200 && force.json.item.qty === 9, JSON.stringify(force.json).slice(0, 120));

    const noBase = await req(base, 'PUT', '/api/items/' + encodeURIComponent(id),
      { cookie, body: { qty: 4 } });
    check('不带版本号时退化成老行为（不拦）',
      noBase.status === 200 && noBase.json.item.qty === 4, String(noBase.status));
  }

  /* ---------- 3. 登录限流 ---------- */

  if (want('限流')) {
    const mem = await req(base, 'POST', '/api/members',
      { cookie, body: { name: '有密码的人', role: 'member', password: 'right-pass' } });
    const mid = mem.json.member.id;

    let last = null;
    for (let i = 0; i < 5; i += 1) {
      last = await req(base, 'POST', '/api/auth/login',
        { body: { memberId: mid, password: 'wrong-' + i } });
    }
    check('前几次错密码是 401', last.status === 401, String(last.status));
    check('错到上限时提示里说清还要等多久',
      /分钟后再试/.test(String(last.json && last.json.error)), String(last.json && last.json.error));

    const locked = await req(base, 'POST', '/api/auth/login',
      { body: { memberId: mid, password: 'right-pass' } });
    check('锁定期间正确密码也是 429（这才是拦得住）', locked.status === 429, String(locked.status));
    check('429 带 retryAfterSec', Number(locked.json && locked.json.retryAfterSec) > 0,
      JSON.stringify(locked.json));

    // 换个人不该被牵连：键是「成员 + IP」，不是全局
    const other = await req(base, 'POST', '/api/members',
      { cookie, body: { name: '另一个人', role: 'member', password: 'ok-pass' } });
    const login2 = await req(base, 'POST', '/api/auth/login',
      { body: { memberId: other.json.member.id, password: 'ok-pass' } });
    check('锁一个人不影响别人登录', login2.status === 200, String(login2.status));
  }

  /* ---------- 4. 搜索语义 ---------- */

  if (want('搜索')) {
    const room = await req(base, 'POST', '/api/locations',
      { cookie, body: { name: '测试房间甲', parent: null, kind: 'home' } });
    const locId = room.json.location.id;
    await req(base, 'POST', '/api/items',
      { cookie, body: { name: '百分之百充电线', note: '抽屉里那根', tags: '备用、耗材', locId } });

    const byName = await req(base, 'GET', '/api/items?q=' + encodeURIComponent('充电'), { cookie });
    check('按名称搜到', (byName.json.items || []).some((i) => i.name === '百分之百充电线'),
      JSON.stringify((byName.json.items || []).map((i) => i.name)));

    const byTag = await req(base, 'GET', '/api/items?q=' + encodeURIComponent('耗材'), { cookie });
    check('按标签搜到', (byTag.json.items || []).some((i) => i.name === '百分之百充电线'), '没搜到');

    const byNote = await req(base, 'GET', '/api/items?q=' + encodeURIComponent('那根'), { cookie });
    check('按备注搜到', (byNote.json.items || []).some((i) => i.name === '百分之百充电线'), '没搜到');

    const byPath = await req(base, 'GET', '/api/items?q=' + encodeURIComponent('测试房间甲'), { cookie });
    check('按路径搜到', (byPath.json.items || []).some((i) => i.name === '百分之百充电线'), '没搜到');

    // % 和 _ 是 LIKE 的通配符，不转义的话「%」会匹配到一切
    const pct = await req(base, 'GET', '/api/items?q=' + encodeURIComponent('%'), { cookie });
    check('% 被当成普通字符而不是通配符',
      (pct.json.items || []).every((i) => i.name.indexOf('%') !== -1 ||
        String(i.note || '').indexOf('%') !== -1 || String(i.path || '').indexOf('%') !== -1),
      '匹配到 ' + (pct.json.items || []).length + ' 条');

    const none = await req(base, 'GET', '/api/items?q=' + encodeURIComponent('绝对不存在的词zzz'), { cookie });
    check('搜不到时返回空数组', (none.json.items || []).length === 0, String((none.json.items || []).length));
  }

  /* ---------- 5. 静态路径穿越 ---------- */

  if (want('穿越')) {
    const up = await req(base, 'GET', '/../data/homebox.db');
    check('.. 穿越被拒（403/404，且拿不到数据库）',
      up.status === 403 || up.status === 404, String(up.status));
    check('穿越响应里没有 SQLite 头', up.text.indexOf('SQLite format') === -1, up.text.slice(0, 40));

    const sibling = await req(base, 'GET', '/..%2fdata%2fhomebox.db');
    check('编码后的穿越也被拒', sibling.status === 403 || sibling.status === 404,
      String(sibling.status));
  }

  /* ---------- 收尾 ---------- */

  console.log('\n结果：');
  out.forEach((r) => console.log('  ' + r));
  const fails = out.filter((r) => r.startsWith('FAIL')).length;
  console.log('\n合计 ' + out.length + ' 项，失败 ' + fails + ' 项');

  const changed = util.diffRealData(before, util.snapshotRealData(REPO));
  const countsAfter = dbcheck.logicalCounts(realDataDir);
  const changedCounts = dbcheck.diffCounts(countsBefore, countsAfter);
  console.log('真实数据未被改动：' + (changed.length ? '否！' + changed.join(',') : '是'));
  console.log('真实库逻辑数据未被改动：' + (changedCounts.length
    ? '否！' + changedCounts.join(',')
    : '是（' + dbcheck.describeCounts(countsAfter) + '）'));

  child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = (changed.length || changedCounts.length) ? 2 : (fails ? 1 : 0);
}

main().catch((e) => {
  console.error('崩了：', e && e.message);
  console.error(e && e.stack);
  process.exitCode = 2;
});
