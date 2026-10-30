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
//
// 注：homebox.db-wal / -shm 刻意不参与失败判定 —— 它们由常驻实例掌管，
// 字节取决于 checkpoint 时机，不是「测试有没有写」的证据（详见 lib/util.js）。
// 取而代之的是 lib/dbcheck.js 的 logicalCounts() 四项逻辑计数不变式。

const path = require('path');

const util = require('./lib/util');
const dbcheck = require('./lib/dbcheck');
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
 * 具体清单见 util.REAL_DATA_FILES（不含 -wal/-shm，理由见 lib/util.js 注释）。
 * @param {string} repoRoot 仓库根
 * @returns {{files:object, photos:object}}
 */
function realDataSnapshot(repoRoot) {
  return util.snapshotRealData(repoRoot);
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
  const dataDir = path.join(repoRoot, 'data');
  const before = realDataSnapshot(repoRoot);
  const countsBefore = dbcheck.logicalCounts(dataDir);

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
  const changed = util.diffRealData(before, after);
  const countsAfter = dbcheck.logicalCounts(dataDir);
  const changedCounts = dbcheck.diffCounts(countsBefore, countsAfter);
  const dataClean = !changed.length && !changedCounts.length;

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
  console.log('真实数据未被改动：' + (changed.length ? '否！' : '是（' +
    Object.keys(before.files).length + ' 个文件 + ' +
    Object.keys(before.photos).length + ' 张照片 sha256 前后一致）'));
  console.log('真实库逻辑数据未被改动（locations/items/wear/photos 四项计数一致）：' +
    (changedCounts.length ? '否！变化的字段：' + changedCounts.join(',')
      : '是（' + dbcheck.describeCounts(countsAfter) + '）'));
  if (changed.length) {
    console.log('  变化的文件：' + changed.join(', '));
  }
  if (changedCounts.length) {
    console.log('  计数前后：' + dbcheck.describeCounts(countsBefore) +
      ' → ' + dbcheck.describeCounts(countsAfter));
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
