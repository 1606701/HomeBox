#!/usr/bin/env node
'use strict';

// HomeBox P1（db.json → SQLite）验收测试入口
//
//   node qa/qa-p1.js                 跑全部
//   node qa/qa-p1.js --only A        只跑 A 组
//   node qa/qa-p1.js --only A1,A5    只跑指定用例
//   node qa/qa-p1.js --list          列出用例
//
// 三条自我约束（写在代码里，别只写在报告里）：
//   1. 只读真实数据：data/homebox.db、db.json.migrated、photos/ 前后各拍一次 sha256 快照，
//      跑完对比，有任何变化直接判本次测试无效；
//   2. 一切写操作发生在 fs.mkdtempSync() 造的临时目录里，结束时一律删掉；
//   3. 只新增 qa/ 下的文件，不修改 server.js / lib/ / public/ / scripts/。

const path = require('path');

const util = require('./lib/util');
const { Runner, fmt } = require('./lib/runner');

/**
 * 解析命令行。
 * @param {string[]} argv 参数
 * @returns {{only:string[], list:boolean}}
 */
function parseArgs(argv) {
  const out = { only: [], list: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--list') out.list = true;
    else if (argv[i] === '--only' && argv[i + 1]) {
      out.only = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    }
  }
  return out;
}

/**
 * 按 --only 过滤用例：支持组前缀（A）与精确 id（A1）。
 * @param {object} runner Runner
 * @param {string[]} only 过滤条件
 */
function applyFilter(runner, only) {
  if (!only.length) return;
  runner.cases = runner.cases.filter((c) => only.some((sel) =>
    c.id === sel || c.id.indexOf(sel) === 0 || c.section.indexOf(sel) === 0));
}

/**
 * 真实数据的完整性快照：这些文件在测试期间必须一个字节都不变。
 * @param {string} repoRoot 仓库根
 * @returns {object}
 */
function realDataSnapshot(repoRoot) {
  const files = [
    path.join(repoRoot, 'data', 'homebox.db'),
    path.join(repoRoot, 'data', 'homebox.db-wal'),
    path.join(repoRoot, 'data', 'db.json.migrated'),
    path.join(repoRoot, 'data', 'db.pre-p1.json.bak')
  ];
  const snap = util.snapshotFiles(files);
  const photos = util.listFiles(path.join(repoRoot, 'data', 'photos')).map((name) =>
    path.join(repoRoot, 'data', 'photos', name));
  return { files: snap, photos: util.snapshotFiles(photos) };
}

/**
 * 打印失败明细。
 * @param {Array} results 结果
 */
function printFailures(results) {
  const failed = results.filter((r) => r.status === 'fail');
  if (!failed.length) return;
  console.log('');
  console.log('失败明细');
  console.log('────────────────────────────────────────');
  failed.forEach((r, i) => {
    console.log((i + 1) + ') ' + r.id + ' ' + r.name);
    console.log('   ' + r.error.split('\n').join('\n   '));
    if (r.repro) console.log('   复现：' + r.repro);
    console.log('');
  });
}

/**
 * 打印 findings（行为变更 / 风险）。
 * @param {Array} findings 观察
 */
function printFindings(findings) {
  if (!findings.length) return;
  console.log('');
  console.log('需要知道的行为变更 / 风险');
  console.log('────────────────────────────────────────');
  findings.forEach((f) => {
    console.log('[' + f.severity.toUpperCase() + '] ' + f.id + ' ' + f.title);
    console.log('  ' + f.detail.split('\n').join('\n  '));
    console.log('');
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = util.REPO_ROOT;
  const before = realDataSnapshot(repoRoot);

  const runner = new Runner('HomeBox v2 P1 数据层迁移 · QA 验收');
  const ctx = { repoRoot, cleanups: [], findings: [] };
  ctx.onCleanup = (fn) => ctx.cleanups.push(fn);

  require('./cases/a-migration').register(runner, ctx);
  require('./cases/b-api').register(runner, ctx);
  require('./cases/c-adversarial').register(runner, ctx);
  require('./cases/d-hygiene').register(runner, ctx);

  if (args.list) {
    runner.cases.forEach((c) => console.log(c.id + '  ' + c.section + '  ' + c.name));
    return 0;
  }
  applyFilter(runner, args.only);

  console.log('');
  console.log('HomeBox P1 验收测试（' + runner.cases.length + ' 条用例）');
  console.log('仓库：' + repoRoot);
  console.log('Node：' + process.version + '   临时目录根：' + require('os').tmpdir());
  console.log('');

  let summary;
  try {
    summary = await runner.run();
  } finally {
    for (const fn of ctx.cleanups.reverse()) {
      try { await fn(); } catch (err) { console.warn('[qa] 清理失败：' + err.message); }
    }
  }

  const after = realDataSnapshot(repoRoot);
  const changedFiles = util.diffSnapshot(before.files, after.files);
  const changedPhotos = util.diffSnapshot(before.photos, after.photos);
  const dataClean = !changedFiles.length && !changedPhotos.length;

  printFailures(summary.results);
  printFindings(summary.findings);

  console.log('');
  console.log('测试报告');
  console.log('════════════════════════════════════════');
  console.log('总用例数：' + summary.counts.total +
    '   通过：' + summary.counts.pass +
    '   失败：' + summary.counts.fail +
    '   跳过：' + summary.counts.skip);
  console.log('耗时：' + (summary.totalMs / 1000).toFixed(1) + ' 秒');
  console.log('真实数据未被改动：' + (dataClean ? '是（' + Object.keys(before.files).length +
    ' 个文件 + ' + Object.keys(before.photos).length + ' 张照片 sha256 前后一致）' : '否！'));
  if (!dataClean) {
    console.log('  变化的文件：' + changedFiles.concat(changedPhotos).join(', '));
  }
  console.log('');

  if (!dataClean) return 2;
  return summary.counts.fail ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error('[qa] 测试框架自身崩了：' + fmt(err && err.message));
  console.error(err && err.stack);
  process.exitCode = 3;
});
