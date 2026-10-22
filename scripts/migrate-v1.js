#!/usr/bin/env node
'use strict';

// v1 → v2 数据迁移（独立可跑）
//
//   node scripts/migrate-v1.js               迁移 data/db.json → data/homebox.db
//   node scripts/migrate-v1.js --force       目标库已存在也强制重跑（会先删库）
//   node scripts/migrate-v1.js --data ./tmp  指定数据目录
//
// 退出码：0 = 成功或无需迁移；1 = 有任何一条验收不过 / 数据不可读。
// 失败时会 ROLLBACK 并把半成品库删掉，data/db.json 一个字节都不会被改动。

const fs = require('fs');
const path = require('path');
const migrate = require('../lib/migrate-v1');
const db = require('../lib/db');

const ROOT = path.join(__dirname, '..');

/**
 * 极简参数解析。
 * @param {string[]} argv 命令行参数
 * @returns {{data:string, force:boolean, help:boolean}}
 */
function parseArgs(argv) {
  const out = { data: '', force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force' || arg === '-f') out.force = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--data' && argv[i + 1]) { out.data = argv[i + 1]; i += 1; }
  }
  return out;
}

function line(text) {
  const s = text === undefined ? '' : String(text);
  console.log(s);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    line('用法：node scripts/migrate-v1.js [--data <数据目录>] [--force]');
    return 0;
  }

  const dataDir = args.data
    ? path.resolve(args.data)
    : (process.env.HB_DATA_DIR ? path.resolve(process.env.HB_DATA_DIR) : path.join(ROOT, 'data'));
  const jsonFile = path.join(dataDir, 'db.json');
  const dbFile = path.join(dataDir, 'homebox.db');
  const backupDir = path.join(dataDir, 'backup');
  const photoDir = path.join(dataDir, 'photos');

  line('');
  line('HomeBox v1 → v2 数据迁移');
  line('────────────────────────────────────────────');
  line('  数据目录  ' + dataDir);
  line('  源文件    ' + jsonFile);
  line('  目标库    ' + dbFile);
  line('');

  if (!fs.existsSync(jsonFile)) {
    line('没有找到 db.json，无需迁移（如果已经迁移过，原文件会叫 db.json.migrated）。');
    line('');
    return 0;
  }

  if (fs.existsSync(dbFile)) {
    if (!args.force) {
      line('目标库已存在：' + dbFile);
      line('说明已经迁移过。真的要重来，请先备份，再加 --force 重跑（会删除现有库）。');
      line('');
      return 0;
    }
    line('--force：删除现有数据库后重跑');
    db.close();
    ['', '-wal', '-shm'].forEach((suffix) => {
      try { fs.unlinkSync(dbFile + suffix); } catch (err) { /* 不存在就算了 */ }
    });
  }

  let report;
  try {
    report = migrate.migrateFromJson({ dbFile, jsonFile, backupDir, photoDir });
  } catch (err) {
    line('');
    line('[失败] ' + err.message);
    line('');
    return 1;
  }

  line('备份      ' + report.backup);
  line('');
  line('迁移结果：位置 ' + report.counts.locations + ' / 物品 ' + report.counts.items +
    ' / 衣物 ' + report.counts.wear + ' / 照片 ' + report.counts.photo);
  line('');
  line('验收清单');
  let passed = 0;
  report.checks.forEach((item) => {
    if (item.ok) passed += 1;
    line('  [' + (item.ok ? 'PASS' : 'FAIL') + '] ' + item.name +
      (item.detail ? '  —— ' + item.detail : ''));
  });
  line('');
  line('通过 ' + passed + ' / ' + report.checks.length + ' 条');
  line('');

  if (!report.ok) {
    line('[失败] 迁移已回滚，data/db.json 保持原样（备份另存在 ' + report.backup + '）。');
    line('       原因：' + (report.error || '有验收项未通过'));
    line('');
    return 1;
  }

  if (report.archived) {
    line('原文件已改名为 ' + report.archived + ' 留档（未删除，随时可回滚）。');
    line('回滚三步：删 data/homebox.db*；把 db.json.migrated 改回 db.json；代码回退。');
  } else {
    line('注意：db.json 未能改名留档，它已保持原样，请手工确认权限。');
  }
  line('');
  return 0;
}

const code = main();
db.close();
process.exit(code);
