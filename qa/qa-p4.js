'use strict';

// P4 验收：拍照识别（本地 mock 视觉 API，不联网）+ 导出 / 回灌
//
//   node qa/qa-p4.js            跑全部
//   node qa/qa-p4.js --only 识别  按关键字过滤
//
// 约束同 qa-p1/p2：真实 data/ 只读（前后 sha256 快照比对），
// 一切写操作发生在临时目录 + 随机端口，跑完全清。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = require('./lib/util').REPO_ROOT;
const util = require('./lib/util');
let mockReply = '{"name":"五号电池","category":"耗材","tags":["备用"],"location":"厨房","confident":0.8}';
let mockStatus = 200;
let mockDelay = 0;

function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        setTimeout(() => {
          if (mockStatus !== 200) {
            res.writeHead(mockStatus, { 'Content-Type': 'text/plain' });
            res.end('mock error');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: mockReply } }]
          }));
        }, mockDelay);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

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

const WATCH = ['data/homebox.db', 'data/homebox.db-wal', 'data/db.json.migrated']
  .map((p) => path.join(REPO, p));

async function main() {
  const before = util.snapshotFiles(WATCH);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-p4-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'data', 'homebox.db'), path.join(dataDir, 'homebox.db'));

  const mock = await startMock();
  const port = 9300 + Math.floor(Math.random() * 200);
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
  if (!await waitPort(base)) throw new Error('服务没起来\n' + log);

  const setup = await req(base, 'POST', '/api/auth/setup',
    { body: { name: '管理员', password: 'home123456' } });
  const cookie = String(setup.headers['set-cookie'][0]).split(';')[0];

  const out = [];
  const check = (l, c, d) => out.push((c ? 'PASS' : 'FAIL') + '  ' + l + (c ? '' : '  ← ' + (d || '')));

  // 1. 未启用
  const s1 = await req(base, 'GET', '/api/ai/status', { cookie });
  check('未启用时 available=false', s1.json.available === false, JSON.stringify(s1.json));
  const r1 = await req(base, 'POST', '/api/vision/recognize',
    { cookie, body: { image: 'data:image/jpeg;base64,AAAA' } });
  check('未启用时识别接口 404', r1.status === 404, String(r1.status));

  // 2. 启用（指向 mock）
  const save = await req(base, 'PUT', '/api/notify/settings', {
    cookie,
    body: { ai: { enabled: true, preset: 'custom', baseUrl: 'http://127.0.0.1:' + mock.port + '/v1', model: 'mock-vl', apiKey: 'sk-test' } }
  });
  check('保存识别配置', save.status === 200 && save.json.ok, JSON.stringify(save.json));
  check('配置不回显 Key', save.json.settings.ai.hasKey === true &&
    save.json.settings.ai.apiKey === undefined, JSON.stringify(save.json.settings.ai));
  const s2 = await req(base, 'GET', '/api/ai/status', { cookie });
  check('启用后 available=true', s2.json.available === true, JSON.stringify(s2.json));

  // 3. 正常识别
  const ok = await req(base, 'POST', '/api/vision/recognize',
    { cookie, body: { image: 'data:image/jpeg;base64,AAAA' } });
  check('识别成功返回草稿', ok.json.ok === true && ok.json.draft.name === '五号电池',
    JSON.stringify(ok.json));
  check('类目被收敛（耗材→其他）', ok.json.draft.category === '其他', JSON.stringify(ok.json.draft));
  check('房间名被收敛（厨房存在→保留）', ok.json.draft.locationName === '厨房',
    JSON.stringify(ok.json.draft));
  check('标签保留', JSON.stringify(ok.json.draft.tags) === '["备用"]', JSON.stringify(ok.json.draft));

  // 4. 模型返回垃圾
  mockReply = '我觉得这是个东西，无法判断。';
  const bad = await req(base, 'POST', '/api/vision/recognize',
    { cookie, body: { image: 'data:image/jpeg;base64,AAAA' } });
  check('坏 JSON → 200 + unavailable', bad.status === 200 && bad.json.unavailable === true,
    JSON.stringify(bad.json));

  // 5. 模型返回 ```json 包裹
  mockReply = '```json\n{"name":"螺丝刀","category":"工具","tags":[],"location":"不存在的地方","confident":0.9}\n```';
  const fenced = await req(base, 'POST', '/api/vision/recognize',
    { cookie, body: { image: 'data:image/jpeg;base64,AAAA' } });
  check('能剥离 ```json 围栏', fenced.json.draft && fenced.json.draft.name === '螺丝刀',
    JSON.stringify(fenced.json));
  check('不存在的房间被丢弃', fenced.json.draft.locationName === null,
    JSON.stringify(fenced.json.draft));

  // 6. 上游 500
  mockStatus = 500;
  const err500 = await req(base, 'POST', '/api/vision/recognize',
    { cookie, body: { image: 'data:image/jpeg;base64,AAAA' } });
  check('上游 500 → 200 + unavailable', err500.status === 200 && err500.json.unavailable === true,
    JSON.stringify(err500.json));
  mockStatus = 200;

  // 7. 导出
  const exp = await req(base, 'GET', '/api/export', { cookie });
  check('导出成功', exp.status === 200 && exp.json && exp.json.items.length >= 26,
    String(exp.status));
  check('导出带 Content-Disposition', /attachment; filename="homebox-/.test(
    String(exp.headers['content-disposition'])), String(exp.headers['content-disposition']));

  // 8. 回灌：改个名字再灌回去
  const doc = exp.json;
  doc.items[0].name = '回灌后的名字';
  const noConfirm = await req(base, 'POST', '/api/import', { cookie, body: { document: doc } });
  check('没有 confirm 时拒绝', noConfirm.status === 400, String(noConfirm.status));

  const imp = await req(base, 'POST', '/api/import',
    { cookie, body: { document: doc, confirm: 'REPLACE' } });
  check('回灌成功', imp.status === 200 && imp.json.ok, JSON.stringify(imp.json));
  check('回灌后件数一致', imp.json.counts.items === doc.items.length, JSON.stringify(imp.json.counts));
  const list = await req(base, 'GET', '/api/items', { cookie });
  check('回灌后的数据真的替换了', list.json.items.some((i) => i.name === '回灌后的名字'),
    '没找到新名字');
  check('回灌前自动备份过', /backup/.test(String(imp.json.backupFile)), String(imp.json.backupFile));

  // 9. 访客不能导出
  const g = await req(base, 'POST', '/api/members', { cookie, body: { name: '客人', role: 'guest' } });
  const gl = await req(base, 'POST', '/api/auth/login', { body: { memberId: g.json.member.id } });
  const gc = String(gl.headers['set-cookie'][0]).split(';')[0];
  const gexp = await req(base, 'GET', '/api/export', { cookie: gc });
  check('访客不能导出', gexp.status === 403, String(gexp.status));
  const gai = await req(base, 'GET', '/api/ai/status', { cookie: gc });
  check('访客 available=false', gai.json.available === false, JSON.stringify(gai.json));

  console.log('\n结果：');
  out.forEach((r) => console.log('  ' + r));
  const fails = out.filter((r) => r.startsWith('FAIL')).length;
  console.log('\n合计 ' + out.length + ' 项，失败 ' + fails + ' 项');

  const changed = util.diffSnapshot(before, util.snapshotFiles(WATCH));
  console.log('真实数据未被改动：' + (changed.length ? '否！' + changed.join(',') : '是'));

  child.kill('SIGKILL');
  mock.srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = changed.length ? 2 : (fails ? 1 : 0);
}

main().catch((e) => {
  console.error('崩了：', e && e.message);
  console.error(e && e.stack);
  process.exitCode = 2;
});
