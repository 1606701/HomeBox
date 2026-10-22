'use strict';

// 启动编排：目录 → 起库 → 建表/迁移 → 首次数据（迁移 JSON 或写示例）→ 自检
//
// server.js、scripts/export.js、scripts/migrate-v1.js 共用同一套流程，
// 避免三份「先做什么后做什么」的隐性知识。
//
// 一条硬规则：任何一步发现数据不可信（JSON 解析失败、integrity_check 不通过），
// 一律抛致命错误让进程 exit(1)。绝不允许带着坏库继续服务 ——
// 那是旧版 readDB() 静默 return seed() 里最危险的一环。

const fs = require('fs');
const path = require('path');
const db = require('./db');
const http = require('./http');
const photos = require('./photos');
const seed = require('./seed');
const migrateV1 = require('./migrate-v1');

/**
 * 造一个致命错误。
 * @param {string} message 说明
 * @param {object} [extra] 附加字段
 * @returns {Error}
 */
function fatal(message, extra) {
  const err = new Error(message);
  err.fatal = true;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * 启动。
 * @param {object} options 选项
 * @param {string} options.dataDir 数据目录（默认 <root>/data）
 * @param {string} [options.publicDir] 静态资源目录
 * @param {boolean} [options.seedWhenEmpty=true] 新建库且没有 v1 数据时是否写示例数据
 * @param {boolean} [options.allowMigrate=true] 新建库且存在 db.json 时是否自动迁移
 * @returns {object} 启动结果（路径、迁移报告、自检结果）
 */
function boot(options) {
  const cfg = options || {};
  if (!cfg.dataDir) throw fatal('boot() 必须提供 dataDir');

  const dataDir = path.resolve(cfg.dataDir);
  const dbFile = path.join(dataDir, 'homebox.db');
  const jsonFile = path.join(dataDir, 'db.json');
  const photoDir = path.join(dataDir, 'photos');
  const backupDir = path.join(dataDir, 'backup');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(photoDir, { recursive: true });
  photos.configure({ dir: photoDir });
  if (cfg.publicDir) http.configure({ publicDir: path.resolve(cfg.publicDir) });

  const fresh = !fs.existsSync(dbFile);
  const hasV1 = fs.existsSync(jsonFile);
  let migration = null;
  let seeded = null;

  // 新建库 + 有 v1 数据 → 先迁移。migrateFromJson 内部会起库并建表。
  if (fresh && hasV1 && cfg.allowMigrate !== false) {
    migration = migrateV1.migrateFromJson({ dbFile, jsonFile, backupDir, photoDir });
    if (!migration.ok) {
      throw fatal('v1 数据迁移失败，已回滚并保留原 db.json。原因：' +
        (migration.error || '未知'), { migration });
    }
  }
  try {
    db.open(dbFile);
    db.migrateSchema();
  } catch (err) {
    // 库文件坏了（半截文件、不是 SQLite、被外部工具改烂）——宁可不启动
    throw fatal('【严重】数据库打不开或版本迁移失败：' + err.message +
      '\n数据库文件：' + dbFile +
      '\n请从 data/backup/ 里最近的备份恢复：' +
      '\n  1) 停掉服务；2) 把备份 JSON 放回 data/db.json；' +
      '\n  3) 删掉 data/homebox.db / -wal / -shm；4) 重新启动（会自动重新导入）。',
      { cause: err });
  }

  // 只有「刚建出来的空库」才写示例数据，避免用户把东西删光后重启又冒出示例
  if (fresh && !migration && !hasV1 && cfg.seedWhenEmpty !== false) {
    seeded = seed.seedIfEmpty();
  }

  const integrity = db.integrityCheck();
  if (!integrity.ok) {
    throw fatal('【严重】数据库自检失败（PRAGMA integrity_check）：' + integrity.rows.join(' / ') +
      '\n数据库文件：' + dbFile +
      '\n请从 data/backup/ 里最近的备份恢复：' +
      '\n  1) 停掉服务；2) 把备份 JSON 放回 data/db.json；' +
      '\n  3) 删掉 data/homebox.db / -wal / -shm；4) 重新启动（会自动重新导入）。',
      { integrity });
  }

  // 老数据补坐标（旧版 ensureStorage 的行为，幂等）
  const backfilled = seed.backfillKnownBoxes();

  return {
    dataDir,
    dbFile,
    jsonFile,
    photoDir,
    backupDir,
    fresh,
    migration,
    seeded,
    backfilled,
    integrity,
    info: db.info()
  };
}

module.exports = { boot, fatal };
