'use strict';

// 起停服务进程、跑迁移脚本、准备新旧两套工程目录。
//
// 新版：`node server.js` + HB_DATA_DIR=<临时目录>（server.js 里专门为自动化测试留的钩子）
// 旧版：把 main 分支的 server.js 拉到独立目录跑，它硬编码 <__dirname>/data，
//       所以必须给它一整套目录结构（server.js + public/ + data/db.json + data/photos/）。

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const util = require('./util');
const httpc = require('./httpc');

const NODE = process.execPath;
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

// 旧版基线提交：与 main 分支一致
const BASE_COMMIT = '451d965';

/**
 * 把一份 v1 db.json 与照片复制进临时数据目录。
 * @param {string} repoRoot 仓库根
 * @param {string} dataDir 目标数据目录
 * @param {string} [sourceJson] 源 JSON（默认 data/db.json.migrated）
 */
function prepareDataDir(repoRoot, dataDir, sourceJson) {
  const src = sourceJson || path.join(repoRoot, 'data', 'db.json.migrated');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(src, path.join(dataDir, 'db.json'));
  const photosSrc = path.join(repoRoot, 'data', 'photos');
  if (fs.existsSync(photosSrc)) util.copyDir(photosSrc, path.join(dataDir, 'photos'));
}

/**
 * 在指定数据目录跑迁移脚本。
 * @param {string} repoRoot 仓库根
 * @param {string} dataDir 数据目录
 * @param {string[]} [extraArgs] 额外参数（如 --force）
 * @returns {{code:number, stdout:string, stderr:string}}
 */
function runMigrate(repoRoot, dataDir, extraArgs) {
  const args = NODE_FLAGS.concat(
    [path.join(repoRoot, 'scripts', 'migrate-v1.js'), '--data', dataDir],
    extraArgs || []
  );
  const res = spawnSync(NODE, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { HB_DATA_DIR: dataDir })
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/**
 * 起一个新版服务并等待可用。
 * @param {object} opts 选项
 * @param {string} opts.repoRoot 仓库根
 * @param {string} opts.dataDir 数据目录
 * @param {number} [opts.port] 端口（不传则自动挑一个）
 * @param {object} [opts.env] 额外环境变量
 * @returns {Promise<object>} 服务句柄
 */
async function startNewServer(opts) {
  const port = opts.port || await util.freePort();
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    HB_DATA_DIR: opts.dataDir
  }, opts.env || {});
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  return startProcess({
    label: 'new',
    cwd: opts.repoRoot,
    args: NODE_FLAGS.concat([path.join(opts.repoRoot, 'server.js')]),
    env,
    port
  });
}

/**
 * 起一个旧版（main 分支）服务并等待可用。
 * @param {object} opts 选项
 * @param {string} opts.oldRoot 旧版工程目录（含 server.js / public / data）
 * @param {number} [opts.port] 端口
 * @returns {Promise<object>} 服务句柄
 */
async function startOldServer(opts) {
  const port = opts.port || await util.freePort();
  const env = Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' });
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.HB_DATA_DIR;
  return startProcess({
    label: 'old',
    cwd: opts.oldRoot,
    args: [path.join(opts.oldRoot, 'server.js')],
    env,
    port
  });
}

/**
 * 起进程 + 等端口可用。
 * @param {object} opts 选项
 * @returns {Promise<object>}
 */
async function startProcess(opts) {
  const child = spawn(NODE, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const handle = {
    label: opts.label,
    port: opts.port,
    base: 'http://127.0.0.1:' + opts.port,
    child,
    stdout: '',
    stderr: '',
    exited: false,
    exit: null
  };
  child.stdout.on('data', (d) => { handle.stdout += d.toString(); });
  child.stderr.on('data', (d) => { handle.stderr += d.toString(); });
  child.on('exit', (code, signal) => {
    handle.exited = true;
    handle.exit = { code, signal };
  });

  const ready = await util.waitUntil(async () => {
    if (handle.exited) return false;
    try {
      const res = await httpc.request(handle.base, 'GET', '/api/locations', { timeout: 1500 });
      return res.status > 0;
    } catch (err) {
      return false;
    }
  }, 25000, 120);

  if (!ready) {
    await stopServer(handle);
    throw new Error('[' + opts.label + '] 服务没有在 25 秒内就绪。\nstdout:\n' +
      handle.stdout + '\nstderr:\n' + handle.stderr);
  }
  return handle;
}

/**
 * 停服务：先 SIGTERM，5 秒不退则强杀。
 * @param {object} handle startProcess 返回的句柄
 * @returns {Promise<void>}
 */
async function stopServer(handle) {
  if (!handle || !handle.child || handle.exited) return;
  try { handle.child.kill('SIGTERM'); } catch (err) { /* 已退出 */ }
  const gone = await util.waitUntil(() => handle.exited, 5000, 80);
  if (!gone) {
    try { handle.child.kill('SIGKILL'); } catch (err) { /* 忽略 */ }
    await util.waitUntil(() => handle.exited, 3000, 80);
  }
}

/**
 * 跑一个短命命令并等它退出（迁移失败、坏库启动这类用例要用退出码）。
 * @param {object} opts 选项
 * @param {string} opts.cwd 工作目录
 * @param {string[]} opts.args node 参数（不含 node 本身）
 * @param {object} [opts.env] 环境变量
 * @param {number} [opts.timeoutMs] 超时
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string}>}
 */
function runNodeSync(opts) {
  const res = spawnSync(NODE, NODE_FLAGS.concat(opts.args), {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 30000,
    env: Object.assign({}, process.env, opts.env || {})
  });
  return {
    code: res.status,
    signal: res.signal,
    stdout: res.stdout || '',
    stderr: res.stderr || ''
  };
}

/**
 * 准备旧版工程目录：server.js（main 分支）+ public/ + data/db.json + data/photos/。
 * @param {string} repoRoot 仓库根
 * @param {string} targetDir 目标目录
 * @param {string} [commit] 基线提交
 * @returns {{ok:boolean, reason?:string}}
 */
function prepareOldRoot(repoRoot, targetDir, commit) {
  const rev = commit || BASE_COMMIT;
  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
  const res = spawnSync('git', ['show', rev + ':server.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (res.status !== 0 || !res.stdout) {
    return { ok: false, reason: '取不到 ' + rev + ':server.js（' + (res.stderr || '').trim() + '）' };
  }
  fs.writeFileSync(path.join(targetDir, 'server.js'), res.stdout, 'utf8');
  util.copyDir(path.join(repoRoot, 'public'), path.join(targetDir, 'public'));
  prepareDataDir(repoRoot, path.join(targetDir, 'data'));
  return { ok: true };
}

module.exports = {
  NODE,
  NODE_FLAGS,
  BASE_COMMIT,
  prepareDataDir,
  runMigrate,
  startNewServer,
  startOldServer,
  stopServer,
  runNodeSync,
  prepareOldRoot
};
