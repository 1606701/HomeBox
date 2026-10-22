#!/usr/bin/env node
'use strict';

// 导出人类可读 JSON（与 v1 的 data/db.json 结构兼容，便于回灌与备份）
//
//   node scripts/export.js                     写到 data/backup/homebox-<时间戳>.json
//   node scripts/export.js --out /mnt/backup   写到指定目录（自动文件名），定时备份用这个
//   node scripts/export.js --out ./我的备份.json
//   node scripts/export.js --data ./tmp        指定数据目录
//
// 导出的东西是「业务数据」，不含 events 留痕、不含 SQLite 内部结构，
// 所以拿它当备份/迁移都有意义；反过来也能一眼看出库里的东西对不对。
// 注意照片不在 JSON 里（只存文件名），照片要单独 rsync data/photos/。

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const locations = require('../lib/repo/locations');
const items = require('../lib/repo/items');
const migrate = require('../lib/migrate-v1');

const ROOT = path.join(__dirname, '..');

/**
 * 极简参数解析。
 * @param {string[]} argv 命令行参数
 * @returns {{data:string, out:string, help:boolean}}
 */
function parseArgs(argv) {
  const out = { data: '', out: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--out' || arg === '-o') && argv[i + 1]) { out.out = argv[i + 1]; i += 1; }
    else if (arg === '--data' && argv[i + 1]) { out.data = argv[i + 1]; i += 1; }
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

/**
 * 组装导出文档。
 * @returns {object} 与 v1 db.json 结构兼容的文档
 */
function buildDocument() {
  const settings = locations.loadSettings();
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: {
      planWidthM: settings.planWidthM,
      // DECISIONS D2：固定单币种，只供导出文件自描述，不暴露给用户
      base_currency: db.getSetting('base_currency', 'CNY')
    },
    locations: locations.list(),
    items: items.listRows().map(items.rowToItem)
  };
}

/**
 * 算出导出文件应该写在哪。
 *
 * `--out` 支持两种写法：
 *   · 目录（已存在的目录、以分隔符结尾、或没有 .json 后缀）→ 目录 + 自动文件名
 *   · 具体文件（带 .json 后缀）→ 就用它
 *
 * 支持目录是为了配合定时备份：`npm run export -- --out /mnt/backup`
 * 这种写法把备份放到「data/ 树外」，不会被后续的全量打包再套一层。
 *
 * @param {string} out --out 原始值（可为空）
 * @param {string} backupDir 默认备份目录
 * @returns {string} 绝对路径
 */
function resolveTarget(out, backupDir) {
  const name = 'homebox-' + migrate.timestamp() + '.json';
  if (!out) return path.join(backupDir, name);
  const abs = path.resolve(out);
  let isDir = /[\\/]$/.test(out);
  if (!isDir) {
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch (err) {
      // 目录还不存在：没有 .json 后缀就当目录，后面会 mkdir -p
      isDir = !/\.json$/i.test(abs);
    }
  }
  return isDir ? path.join(abs, name) : abs;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/export.js [--out <文件或目录>] [--data <数据目录>]');
    console.log('  --out 目录（或不带 .json 后缀）→ 自动命名为 homebox-<时间戳>.json');
    console.log('  不写 --out → 默认写到 data/backup/（只适合手动导出；定时备份请指到树外目录）');
    return 0;
  }

  const dataDir = args.data
    ? path.resolve(args.data)
    : (process.env.HB_DATA_DIR ? path.resolve(process.env.HB_DATA_DIR) : path.join(ROOT, 'data'));
  const dbFile = path.join(dataDir, 'homebox.db');
  const backupDir = path.join(dataDir, 'backup');

  if (!fs.existsSync(dbFile)) {
    console.error('[失败] 找不到数据库 ' + dbFile + '，先跑 node scripts/migrate-v1.js');
    return 1;
  }

  db.open(dbFile);
  db.migrateSchema();

  const integrity = db.integrityCheck();
  if (!integrity.ok) {
    console.error('[失败] 数据库自检不通过，拒绝导出：' + integrity.rows.join(' / '));
    return 1;
  }

  const doc = buildDocument();
  const target = resolveTarget(args.out, backupDir);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(doc, null, 2), 'utf8');

  const wearCount = doc.items.filter((i) => i.wear).length;
  const photoCount = doc.items.filter((i) => i.photo).length;
  console.log('');
  console.log('已导出： ' + target);
  console.log('  位置 ' + doc.locations.length + ' / 物品 ' + doc.items.length +
    ' / 衣物 ' + wearCount + ' / 照片 ' + photoCount +
    ' / planWidthM ' + doc.settings.planWidthM);
  console.log('');
  return 0;
}

let code = 0;
try {
  code = main();
} catch (err) {
  console.error('[失败] ' + (err.message || err));
  code = 1;
}
db.close();
process.exit(code);
