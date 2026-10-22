'use strict';

// v1（单个 data/db.json）→ v2（SQLite）迁移
//
// 铁律（对应 docs/v2/ARCHITECTURE.md §2.5 与 R3/R6 风险）：
//   1. 迁移前先把 db.json 复制到 data/backup/db.pre-v2.<时间戳>.json；
//   2. 原文件只改名 db.json.migrated 留档，永不删除；
//   3. 8 条验收全部在事务内跑完，任一不过就 ROLLBACK + 保留 JSON + 删掉半成品库；
//   4. JSON 解析失败绝不「静默重建」—— 这是旧版最高危的 bug，
//      坏文件会显示示例数据，用户一点就把真实数据覆盖成种子。

const fs = require('fs');
const path = require('path');
const db = require('./db');
const photos = require('./photos');
const { nowISO } = require('./util');
const { SCHEMA_VERSION } = require('./schema');

/**
 * 造一个「必须终止进程」的错误。CLI 与 server 都会据此 exit(1)。
 * @param {string} message 错误说明
 * @param {object} [extra] 附加字段（如验收明细）
 * @returns {Error}
 */
function fatal(message, extra) {
  const err = new Error(message);
  err.fatal = true;
  if (extra) Object.assign(err, extra);
  return err;
}

// 20261022-113045，用于备份文件名，避免同一秒内覆盖
function timestamp() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/**
 * 读并解析 v1 数据文件。解析失败直接抛出致命错误，绝不返回种子数据。
 * @param {string} jsonFile 文件路径
 * @returns {object} 解析后的 v1 文档
 */
function readSource(jsonFile) {
  let raw;
  try {
    raw = fs.readFileSync(jsonFile, 'utf8');
  } catch (err) {
    throw fatal('读不到 v1 数据文件 ' + jsonFile + '（' + err.code + '）。' +
      '请确认路径，或从 data/backup/ 里的备份恢复后再启动。');
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw fatal('【严重】v1 数据文件无法解析：' + err.message + '\n' +
      '真实数据一个字节都没有改动，也绝不会被示例数据覆盖。\n' +
      '请从 data/backup/db.pre-v2.*.json 或你的 U 盘备份恢复 db.json 后重试。');
  }
  if (!doc || typeof doc !== 'object' ||
      !Array.isArray(doc.locations) || !Array.isArray(doc.items)) {
    throw fatal('【严重】' + jsonFile + ' 的结构不是 v1（缺少 locations / items 数组）。\n' +
      '真实数据未改动。请从备份恢复后重试。');
  }
  return doc;
}

/**
 * 备份原文件。
 * @param {string} jsonFile 源文件
 * @param {string} backupDir 备份目录
 * @returns {string} 备份文件路径
 */
function backupSource(jsonFile, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, 'db.pre-v2.' + timestamp() + '.json');
  fs.copyFileSync(jsonFile, target);
  return target;
}

// 迁移失败时把半成品库删干净，保证下次启动不会误以为「已经迁过」
function removeDbFiles(dbFile) {
  ['', '-wal', '-shm'].forEach((suffix) => {
    try { fs.unlinkSync(dbFile + suffix); } catch (err) { /* 不存在就算了 */ }
  });
}

/**
 * 把 box 对象拆成四列。
 * @param {*} box v1 的 {x,y,w,h} 或空
 * @returns {{x:number|null,y:number|null,w:number|null,h:number|null}}
 */
function splitBox(box) {
  if (!box || typeof box !== 'object') return { x: null, y: null, w: null, h: null };
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
      !Number.isFinite(w) || !Number.isFinite(h)) {
    return { x: null, y: null, w: null, h: null };
  }
  return { x, y, w, h };
}

/**
 * 事务内插入整份 v1 数据。
 * @param {object} src v1 文档
 * @returns {{locations:number, items:number, wear:number, photo:number}}
 */
function insertAll(src) {
  const t = nowISO();
  const locStmt = db.prepare('INSERT INTO locations (id, name, parent_id, kind, ' +
    'box_x, box_y, box_w, box_h, sort_order, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const itemStmt = db.prepare('INSERT INTO items (id, name, loc_id, note, qty, category, ' +
    'expire_at, remind_days, min_qty, price_cents, buy_date, owner_id, state, lend_to, ' +
    'lend_at, photo, tags, wear_json, created_at, updated_at) ' +
    "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'in_use', " +
    'NULL, NULL, ?, ?, ?, ?, ?)');
  const evStmt = db.prepare('INSERT INTO events (item_id, member_id, kind, payload, ' +
    'created_at) VALUES (?, NULL, ?, ?, ?)');

  // 位置：sort_order 直接用 v1 数组下标，树与列表顺序分毫不差
  src.locations.forEach((loc, index) => {
    const box = splitBox(loc.box);
    locStmt.run(
      String(loc.id),
      String(loc.name == null ? '' : loc.name),
      loc.parent ? String(loc.parent) : null,
      loc.kind || (loc.parent ? 'compartment' : 'home'),
      box.x, box.y, box.w, box.h,
      index,
      String(loc.createdAt || t)
    );
  });

  // 物品：wear 整体进 JSON 列，tags 进 JSON 文本，state 一律 in_use，
  // expire_at / min_qty / price_cents 全 NULL（→ 升级当天不会炸出一堆提醒）
  let wearCount = 0;
  let photoCount = 0;
  src.items.forEach((item) => {
    const wearJson = item.wear && typeof item.wear === 'object'
      ? JSON.stringify(item.wear)
      : null;
    if (wearJson) wearCount += 1;
    if (item.photo) photoCount += 1;
    const qty = Number(item.qty);
    const tags = Array.isArray(item.tags) ? item.tags.map((x) => String(x)) : [];
    itemStmt.run(
      String(item.id),
      String(item.name == null ? '' : item.name),
      item.locId ? String(item.locId) : null,
      String(item.note == null ? '' : item.note),
      Number.isFinite(qty) && qty > 0 ? qty : 1,
      wearJson ? '衣物' : null,
      item.photo ? String(item.photo) : null,
      JSON.stringify(tags),
      wearJson,
      String(item.createdAt || t),
      String(item.updatedAt || item.createdAt || t)
    );
    evStmt.run(String(item.id), 'migrate_v1',
      JSON.stringify({ source: 'db.json', seed: false }), t);
  });

  return { locations: src.locations.length, items: src.items.length,
    wear: wearCount, photo: photoCount };
}

/**
 * 8 条验收。第 1–7 条必须在上面的同一个事务里跑（这样不通过就能整体回滚），
 * 第 8 条 integrity_check 只能在 COMMIT 之后跑才有意义。
 * @param {object} src v1 文档
 * @returns {Array<{name:string, ok:boolean, detail:string}>}
 */
function runChecks(src) {
  const checks = [];
  const push = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  };

  const sameSet = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  };

  const srcLocIds = src.locations.map((l) => String(l.id)).sort();
  const dbLocIds = db.prepare('SELECT id FROM locations').all()
    .map((r) => String(r.id)).sort();
  push('① locations 计数与 id 集合与原 JSON 完全一致',
    dbLocIds.length === srcLocIds.length && sameSet(srcLocIds, dbLocIds),
    '库内 ' + dbLocIds.length + ' 条 / 源文件 ' + srcLocIds.length + ' 条');

  const srcItemIds = src.items.map((i) => String(i.id)).sort();
  const dbItemIds = db.prepare('SELECT id FROM items').all()
    .map((r) => String(r.id)).sort();
  push('② items 计数与 id 集合与原 JSON 完全一致',
    dbItemIds.length === srcItemIds.length && sameSet(srcItemIds, dbItemIds),
    '库内 ' + dbItemIds.length + ' 条 / 源文件 ' + srcItemIds.length + ' 条');

  const expectedWear = src.items.filter((i) => i.wear && typeof i.wear === 'object').length;
  const gotWear = Number(db.prepare('SELECT COUNT(*) AS c FROM items ' +
    'WHERE wear_json IS NOT NULL').get().c);
  push('③ wear_json 非空条数等于源文件衣物数', gotWear === expectedWear,
    '库内 ' + gotWear + ' / 源文件 ' + expectedWear);

  const expectedPhoto = src.items.filter((i) => i.photo).length;
  const photoRows = db.prepare('SELECT id, photo FROM items WHERE photo IS NOT NULL').all();
  const missingPhoto = photoRows
    .filter((r) => !photos.exists(String(r.photo)))
    .map((r) => String(r.photo));
  push('④ 照片条数一致且文件都在 photos 目录里',
    photoRows.length === expectedPhoto && missingPhoto.length === 0,
    '库内 ' + photoRows.length + ' / 源文件 ' + expectedPhoto +
    (missingPhoto.length ? '；缺文件：' + missingPhoto.join(', ') : ''));

  const srcWidth = Number(src.settings && src.settings.planWidthM);
  const expectedWidth = Number.isFinite(srcWidth) && srcWidth > 0 ? srcWidth : 12;
  const gotWidth = Number(db.getSetting('planWidthM', '0'));
  push('⑤ settings.planWidthM 与原值一致', gotWidth === expectedWidth,
    '库内 ' + gotWidth + ' / 源文件 ' + expectedWidth);

  const badParent = db.prepare('SELECT COUNT(*) AS c FROM locations l ' +
    'WHERE l.parent_id IS NOT NULL AND NOT EXISTS ' +
    '(SELECT 1 FROM locations p WHERE p.id = l.parent_id)').get();
  push('⑥ 没有父子悬空（parent_id 要么为空要么能找到）', Number(badParent.c) === 0,
    '悬空 ' + Number(badParent.c) + ' 条');

  const badLoc = db.prepare('SELECT COUNT(*) AS c FROM items i ' +
    'WHERE i.loc_id IS NOT NULL AND NOT EXISTS ' +
    '(SELECT 1 FROM locations l WHERE l.id = i.loc_id)').get();
  push('⑦ 没有物品指向不存在的位置', Number(badLoc.c) === 0,
    '悬空 ' + Number(badLoc.c) + ' 条');

  return checks;
}

/**
 * 执行迁移。
 * @param {object} opts 选项
 * @param {string} opts.dbFile 目标 SQLite 文件
 * @param {string} opts.jsonFile 源 v1 文件
 * @param {string} opts.backupDir 备份目录
 * @param {string} opts.photoDir 照片目录（验收第 4 条要检查文件在不在）
 * @returns {{ok:boolean, checks:Array, counts:object, backup:string, archived:string, dbFile:string}}
 */
function migrateFromJson(opts) {
  const cfg = opts || {};
  const dbFile = path.resolve(cfg.dbFile);
  const jsonFile = path.resolve(cfg.jsonFile);
  const backupDir = path.resolve(cfg.backupDir);
  const photoDir = path.resolve(cfg.photoDir);

  photos.configure({ dir: photoDir });

  // 0. 先读源文件：这一步失败，磁盘上除了多一份备份之外什么都没变
  const src = readSource(jsonFile);

  // 1. 备份
  const backup = backupSource(jsonFile, backupDir);

  // 2. 起库 + 建表，然后单事务灌数据 + 跑验收
  const dbExisted = fs.existsSync(dbFile);
  db.open(dbFile);
  db.migrateSchema();

  let counts = { locations: 0, items: 0, wear: 0, photo: 0 };
  let checks = [];
  try {
    db.tx(() => {
      counts = insertAll(src);
      db.setSetting('planWidthM', Number(src.settings && src.settings.planWidthM) > 0
        ? Number(src.settings.planWidthM)
        : 12);
      db.setSetting('base_currency', 'CNY');
      db.setSetting('schema_version', SCHEMA_VERSION);

      // 1–7 条必须在事务内跑：不通过就 throw，让 db.tx 整体 ROLLBACK
      checks = runChecks(src);
      const failed = checks.filter((x) => !x.ok);
      if (failed.length) {
        const err = new Error('迁移验收未通过：' + failed.map((x) => x.name).join('；'));
        err.checks = checks;
        throw err;
      }
    });
  } catch (err) {
    if (err.checks) checks = err.checks;
    db.close();
    if (!dbExisted) removeDbFiles(dbFile);
    return {
      ok: false,
      checks,
      counts,
      backup,
      archived: '',
      dbFile,
      error: err.message
    };
  }

  // 3. 第 8 条：integrity_check 必须在 COMMIT 之后
  const integrity = db.integrityCheck();
  checks = checks.concat([{
    name: '⑧ PRAGMA integrity_check = ok',
    ok: integrity.ok,
    detail: integrity.rows.join(' / ')
  }]);
  if (!integrity.ok) {
    db.close();
    if (!dbExisted) removeDbFiles(dbFile);
    return {
      ok: false,
      checks,
      counts,
      backup,
      archived: '',
      dbFile,
      error: 'integrity_check 未通过，已删除半成品数据库'
    };
  }

  // 4. 原文件只改名留档，永不删除
  let archived = '';
  try {
    let target = jsonFile + '.migrated';
    if (fs.existsSync(target)) target = jsonFile + '.migrated.' + timestamp();
    fs.renameSync(jsonFile, target);
    archived = target;
  } catch (err) {
    // 改名失败不影响数据安全（数据已在库里 + 备份也在），只提示
    archived = '';
    checks = checks.concat([{
      name: '（提示）db.json 改名留档',
      ok: true,
      detail: '改名失败：' + err.message + '，原文件保持不动'
    }]);
  }

  return { ok: true, checks, counts, backup, archived, dbFile };
}

module.exports = { migrateFromJson, readSource, runChecks, timestamp, fatal };
