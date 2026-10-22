'use strict';

// A 组：迁移与数据完整性
//
// 一律在临时目录里用 data/db.json.migrated 当源文件重跑迁移，
// 然后把迁出来的库直接读出来，逐字段、逐浮点位与源 JSON 对账。

const fs = require('fs');
const path = require('path');

const util = require('../lib/util');
const servers = require('../lib/servers');
const dbcheck = require('../lib/dbcheck');
const httpc = require('../lib/httpc');
const { expect } = require('../lib/runner');

/**
 * 把源 JSON 读成对象。
 * @param {string} repoRoot 仓库根
 * @returns {object}
 */
function readSource(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'db.json.migrated'), 'utf8'));
}

/**
 * 在全新的临时数据目录里跑一次迁移（源文件可替换）。
 * @param {string} repoRoot 仓库根
 * @param {object} doc 源文档
 * @returns {{dir:string, dataDir:string, result:object}}
 */
function migrateWith(repoRoot, doc) {
  const dir = util.makeTempDir('hb-qa-migrate-');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(doc, null, 2), 'utf8');
  util.copyDir(path.join(repoRoot, 'data', 'photos'), path.join(dataDir, 'photos'));
  const result = servers.runMigrate(repoRoot, dataDir);
  return { dir, dataDir, result };
}

/**
 * 深拷贝一份源文档，方便按用例改坏。
 * @param {object} doc 文档
 * @returns {object}
 */
function clone(doc) {
  return JSON.parse(JSON.stringify(doc));
}

/**
 * 把库里的位置/物品/设置与源 JSON 逐字段比对，返回问题列表（空数组 = 完全一致）。
 * @param {string} dbFile 数据库文件
 * @param {object} src 源文档
 * @returns {string[]} 问题描述
 */
function compareDbWithSource(dbFile, src) {
  const problems = [];
  const locs = dbcheck.locations(dbFile);
  if (locs.length !== src.locations.length) {
    problems.push('位置条数：库内 ' + locs.length + ' ≠ 源 ' + src.locations.length);
  }
  src.locations.forEach((want, index) => {
    const got = locs[index];
    if (!got) { problems.push('位置 #' + index + ' 缺行'); return; }
    if (String(got.id) !== String(want.id)) problems.push('位置 #' + index + ' id');
    if (String(got.name) !== String(want.name)) problems.push('位置 #' + index + ' name');
    const wantParent = want.parent ? String(want.parent) : null;
    const gotParent = got.parent_id === null ? null : String(got.parent_id);
    if (gotParent !== wantParent) {
      problems.push('位置 #' + index + ' parent：' + gotParent + ' ≠ ' + wantParent);
    }
    if (String(got.kind) !== String(want.kind)) problems.push('位置 #' + index + ' kind');
    if (Number(got.sort_order) !== index) problems.push('位置 #' + index + ' sort_order');
    if (String(got.created_at) !== String(want.createdAt)) {
      problems.push('位置 #' + index + ' createdAt');
    }
    const wantBox = want.box && typeof want.box === 'object' ? want.box : null;
    if (!wantBox) {
      const allNull = got.box_x === null && got.box_y === null &&
        got.box_w === null && got.box_h === null;
      if (!allNull) problems.push('位置 #' + index + ' 无 box 却落了坐标');
    } else {
      ['x', 'y', 'w', 'h'].forEach((k) => {
        const g = got['box_' + k];
        if (g === null || Number(g) !== Number(wantBox[k])) {
          problems.push('位置 #' + index + ' box.' + k + '：' + g + ' ≠ ' + wantBox[k]);
        }
      });
    }
  });

  const rows = dbcheck.items(dbFile);
  if (rows.length !== src.items.length) {
    problems.push('物品条数：库内 ' + rows.length + ' ≠ 源 ' + src.items.length);
  }
  src.items.forEach((want, index) => {
    const got = rows[index];
    if (!got) { problems.push('物品 #' + index + ' 缺行'); return; }
    if (String(got.id) !== String(want.id)) problems.push('物品 #' + index + ' id');
    if (String(got.name) !== String(want.name)) problems.push('物品 #' + index + ' name');
    const wantLoc = want.locId ? String(want.locId) : null;
    const gotLoc = got.loc_id === null ? null : String(got.loc_id);
    if (gotLoc !== wantLoc) problems.push('物品 #' + index + ' locId：' + gotLoc + ' ≠ ' + wantLoc);
    if (String(got.note) !== String(want.note || '')) problems.push('物品 #' + index + ' note');
    if (Number(got.qty) !== Number(want.qty)) problems.push('物品 #' + index + ' qty');
    if (JSON.stringify(JSON.parse(String(got.tags))) !== JSON.stringify(want.tags || [])) {
      problems.push('物品 #' + index + ' tags');
    }
    const wantWear = want.wear && typeof want.wear === 'object' ? want.wear : null;
    const gotWear = got.wear_json === null ? null : JSON.parse(String(got.wear_json));
    if (JSON.stringify(gotWear) !== JSON.stringify(wantWear)) problems.push('物品 #' + index + ' wear');
    const wantPhoto = want.photo ? String(want.photo) : null;
    const gotPhoto = got.photo === null ? null : String(got.photo);
    if (gotPhoto !== wantPhoto) problems.push('物品 #' + index + ' photo');
    if (String(got.created_at) !== String(want.createdAt)) problems.push('物品 #' + index + ' createdAt');
    if (String(got.updated_at) !== String(want.updatedAt)) problems.push('物品 #' + index + ' updatedAt');
  });

  const width = Number(dbcheck.setting(dbFile, 'planWidthM'));
  const wantWidth = Number(src.settings && src.settings.planWidthM);
  if (width !== wantWidth) problems.push('planWidthM：库内 ' + width + ' ≠ 源 ' + wantWidth);
  return problems;
}

/**
 * 注册 A 组用例。
 * @param {object} runner Runner 实例
 * @param {object} ctx 共享上下文
 */
function register(runner, ctx) {
  const repoRoot = ctx.repoRoot;
  runner.section('A 迁移与数据完整性');

  runner.test('A1', '迁移成功：计数 19/26/14/1、8 条验收全过、原文件改名留档、备份一致',
    async () => {
      const { dir, dataDir, result } = migrateWith(repoRoot, readSource(repoRoot));
      try {
        expect.eq(result.code, 0, '迁移退出码');
        expect.includes(result.stdout, '位置 19 / 物品 26 / 衣物 14 / 照片 1', '迁移计数');
        expect.includes(result.stdout, '通过 8 / 8 条', '验收条数');
        expect.ok(fs.existsSync(path.join(dataDir, 'homebox.db')), '数据库文件应存在');
        expect.ok(fs.existsSync(path.join(dataDir, 'db.json.migrated')), '原文件应改名为 .migrated');
        expect.ok(!fs.existsSync(path.join(dataDir, 'db.json')), '原 db.json 不应还在原地');

        const backups = util.listFiles(path.join(dataDir, 'backup'));
        expect.eq(backups.length, 1, '备份文件个数');
        const backupSha = util.sha256File(path.join(dataDir, 'backup', backups[0]));
        const sourceSha = util.sha256File(path.join(dataDir, 'db.json.migrated'));
        expect.eq(backupSha, sourceSha, '备份内容应与原 db.json 完全一致');
        expect.eq(dbcheck.countRows(path.join(dataDir, 'homebox.db'), 'locations'), 19, '库内位置数');
        expect.eq(dbcheck.countRows(path.join(dataDir, 'homebox.db'), 'items'), 26, '库内物品数');
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A1' });

  runner.test('A2', '位置逐字段对账：id/名称/父级/类型/四列坐标（浮点逐位）/创建时间/顺序',
    async () => {
      const src = readSource(repoRoot);
      const { dir, dataDir, result } = migrateWith(repoRoot, src);
      try {
        expect.eq(result.code, 0, '迁移退出码');
        const rows = dbcheck.locations(path.join(dataDir, 'homebox.db'));
        expect.eq(rows.length, src.locations.length, '位置条数');
        const problems = [];
        src.locations.forEach((want, index) => {
          const got = rows[index];
          if (!got) { problems.push('#' + index + ' 缺行'); return; }
          if (String(got.id) !== String(want.id)) problems.push('#' + index + ' id');
          if (String(got.name) !== String(want.name)) problems.push('#' + index + ' name');
          const wantParent = want.parent ? String(want.parent) : null;
          const gotParent = got.parent_id === null ? null : String(got.parent_id);
          if (gotParent !== wantParent) {
            problems.push('#' + index + ' parent：' + gotParent + ' ≠ ' + wantParent);
          }
          if (String(got.kind) !== String(want.kind)) problems.push('#' + index + ' kind');
          if (Number(got.sort_order) !== index) problems.push('#' + index + ' sort_order');
          if (String(got.created_at) !== String(want.createdAt)) problems.push('#' + index + ' createdAt');
          // box：源里没有 / 为 null 的必须是四列全 NULL；有的必须四个数逐位相等
          const wantBox = want.box && typeof want.box === 'object' ? want.box : null;
          if (!wantBox) {
            const allNull = got.box_x === null && got.box_y === null &&
              got.box_w === null && got.box_h === null;
            if (!allNull) problems.push('#' + index + ' 无 box 却落了坐标');
          } else {
            ['x', 'y', 'w', 'h'].forEach((k) => {
              const g = got['box_' + k];
              if (g === null || Number(g) !== Number(wantBox[k])) {
                problems.push('#' + index + ' box.' + k + '：' + g + ' ≠ ' + wantBox[k]);
              }
            });
          }
        });
        if (problems.length) {
          throw new Error('位置字段对不上（' + problems.length + ' 处）：' + problems.slice(0, 10).join('；'));
        }
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A2' });

  runner.test('A3', '物品逐字段对账：id/名称/位置/备注/数量/标签/wear 全对象/照片/双时间戳/顺序',
    async () => {
      const src = readSource(repoRoot);
      const { dir, dataDir, result } = migrateWith(repoRoot, src);
      try {
        expect.eq(result.code, 0, '迁移退出码');
        const rows = dbcheck.items(path.join(dataDir, 'homebox.db'));
        expect.eq(rows.length, src.items.length, '物品条数');
        const problems = [];
        src.items.forEach((want, index) => {
          const got = rows[index];
          if (!got) { problems.push('#' + index + ' 缺行'); return; }
          if (String(got.id) !== String(want.id)) problems.push('#' + index + ' id');
          if (String(got.name) !== String(want.name)) problems.push('#' + index + ' name');
          const wantLoc = want.locId ? String(want.locId) : null;
          const gotLoc = got.loc_id === null ? null : String(got.loc_id);
          if (gotLoc !== wantLoc) problems.push('#' + index + ' locId：' + gotLoc + ' ≠ ' + wantLoc);
          if (String(got.note) !== String(want.note || '')) problems.push('#' + index + ' note');
          if (Number(got.qty) !== Number(want.qty)) problems.push('#' + index + ' qty');
          if (JSON.stringify(JSON.parse(String(got.tags))) !== JSON.stringify(want.tags || [])) {
            problems.push('#' + index + ' tags');
          }
          const wantWear = want.wear && typeof want.wear === 'object' ? want.wear : null;
          const gotWear = got.wear_json === null ? null : JSON.parse(String(got.wear_json));
          if (JSON.stringify(gotWear) !== JSON.stringify(wantWear)) problems.push('#' + index + ' wear');
          const wantPhoto = want.photo ? String(want.photo) : null;
          const gotPhoto = got.photo === null ? null : String(got.photo);
          if (gotPhoto !== wantPhoto) problems.push('#' + index + ' photo');
          if (String(got.created_at) !== String(want.createdAt)) problems.push('#' + index + ' createdAt');
          if (String(got.updated_at) !== String(want.updatedAt)) problems.push('#' + index + ' updatedAt');
        });
        if (problems.length) {
          throw new Error('物品字段对不上（' + problems.length + ' 处）：' + problems.slice(0, 10).join('；'));
        }
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A3' });

  runner.test('A4', '户型设置 planWidthM 迁成 12（数字而非字符串）', async () => {
    const { dir, dataDir, result } = migrateWith(repoRoot, readSource(repoRoot));
    try {
      expect.eq(result.code, 0, '迁移退出码');
      const raw = dbcheck.setting(path.join(dataDir, 'homebox.db'), 'planWidthM');
      expect.eq(raw, '12', 'KV 里存的值');
    } finally {
      util.rmrf(dir);
    }
  }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A4' });

  runner.test('A5', '幂等：迁移完再跑一次 → 提示无需迁移、库文件字节不变、不重复插入', async () => {
    const { dir, dataDir, result } = migrateWith(repoRoot, readSource(repoRoot));
    try {
      expect.eq(result.code, 0, '首次迁移退出码');
      const dbFile = path.join(dataDir, 'homebox.db');
      const before = util.snapshotFiles([dbFile]);
      const second = servers.runMigrate(repoRoot, dataDir);
      expect.eq(second.code, 0, '二次运行退出码');
      expect.includes(second.stdout, '无需迁移', '二次运行提示');
      const after = util.snapshotFiles([dbFile]);
      expect.eq(after[dbFile].sha256, before[dbFile].sha256, '库文件 sha256 应不变');
      expect.eq(after[dbFile].mtimeMs, before[dbFile].mtimeMs, '库文件 mtime 应不变');
      expect.eq(dbcheck.countRows(dbFile, 'locations'), 19, '位置数不变');
      expect.eq(dbcheck.countRows(dbFile, 'items'), 26, '物品数不变');
    } finally {
      util.rmrf(dir);
    }
  }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A5' });

  runner.test('A6', '幂等（另一种情况）：db.json 还在且库已存在 → 提示已迁移过、拒绝重复灌入', async () => {
    const { dir, dataDir, result } = migrateWith(repoRoot, readSource(repoRoot));
    try {
      expect.eq(result.code, 0, '首次迁移退出码');
      // 把留档的 JSON 还原成 db.json，模拟「用户又塞了一份旧文件」
      fs.copyFileSync(path.join(dataDir, 'db.json.migrated'), path.join(dataDir, 'db.json'));
      const dbFile = path.join(dataDir, 'homebox.db');
      const before = util.snapshotFiles([dbFile]);
      const second = servers.runMigrate(repoRoot, dataDir);
      expect.eq(second.code, 0, '二次运行退出码');
      expect.includes(second.stdout, '目标库已存在', '二次运行提示');
      const after = util.snapshotFiles([dbFile]);
      expect.eq(after[dbFile].sha256, before[dbFile].sha256, '库文件 sha256 应不变');
      expect.eq(dbcheck.countRows(dbFile, 'items'), 26, '物品数没有被灌成 52');
    } finally {
      util.rmrf(dir);
    }
  }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A6' });

  runner.test('A7', '失败保护：locations 是字符串 → 非 0 退出、不留半成品库、原文件字节不变',
    async () => {
      const doc = clone(readSource(repoRoot));
      doc.locations = 'oops';
      const { dir, dataDir, result } = migrateWith(repoRoot, doc);
      try {
        // 注意：这里的 db.json 是「改坏之后写进去的那份」，所以基准值要取它自己的 sha256，
        // 不能拿仓库里的原始文件来比（那本来就不一样）。
        const shaBefore = util.sha256File(path.join(dataDir, 'db.json'));
        expect.ok(result.code !== 0, '退出码应为非 0，实际 ' + result.code);
        expect.includes(result.stdout + result.stderr, '结构不是 v1', '错误提示');
        expect.ok(!fs.existsSync(path.join(dataDir, 'homebox.db')), '不应产出 homebox.db');
        expect.ok(!fs.existsSync(path.join(dataDir, 'homebox.db-wal')), '不应产出 -wal');
        expect.ok(!fs.existsSync(path.join(dataDir, 'homebox.db-shm')), '不应产出 -shm');
        expect.ok(fs.existsSync(path.join(dataDir, 'db.json')), 'db.json 必须原地保留');
        expect.eq(util.sha256File(path.join(dataDir, 'db.json')), shaBefore,
          'db.json 内容应一个字节没变');
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A7' });

  runner.test('A8', '失败保护：parent 指向不存在的位置 → ROLLBACK、非 0 退出、无半成品库、原文件保留',
    async () => {
      const doc = clone(readSource(repoRoot));
      doc.locations[1].parent = 'l_nope';
      const { dir, dataDir, result } = migrateWith(repoRoot, doc);
      try {
        expect.ok(result.code !== 0, '退出码应为非 0，实际 ' + result.code);
        // 外键校验已推迟到 COMMIT，悬空引用会先被验收 ⑥ 拦下 —— 报错比 SQLite 原始
        // 错误更具体（指名是哪一类问题），断言跟着收紧到「必须点名 ⑥」
        expect.includes(result.stdout, '迁移验收未通过', '错误原因应是验收不通过');
        expect.includes(result.stdout, '⑥', '应点名 ⑥ 父子悬空');
        expect.includes(result.stdout, '迁移已回滚', '回滚提示');
        expect.ok(!fs.existsSync(path.join(dataDir, 'homebox.db')), '不应产出 homebox.db');
        expect.ok(fs.existsSync(path.join(dataDir, 'db.json')), 'db.json 必须原地保留');
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A8' });

  runner.test('A9', '失败保护：物品 locId 指向不存在的位置 → ROLLBACK、非 0 退出、无半成品库',
    async () => {
      const doc = clone(readSource(repoRoot));
      doc.items[0].locId = 'l_nope';
      const { dir, dataDir, result } = migrateWith(repoRoot, doc);
      try {
        expect.ok(result.code !== 0, '退出码应为非 0，实际 ' + result.code);
        expect.includes(result.stdout, '迁移验收未通过', '错误原因应是验收不通过');
        expect.includes(result.stdout, '⑦', '应点名 ⑦ 物品指向不存在的位置');
        expect.ok(!fs.existsSync(path.join(dataDir, 'homebox.db')), '不应产出 homebox.db');
        expect.ok(fs.existsSync(path.join(dataDir, 'db.json')), 'db.json 必须原地保留');
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A9' });

  runner.test('A10', '自环 parent（l_home.parent = l_home）：迁移不崩、不产生半成品，并记录实际行为',
    async () => {
      const doc = clone(readSource(repoRoot));
      doc.locations[0].parent = doc.locations[0].id;
      const { dir, dataDir, result } = migrateWith(repoRoot, doc);
      try {
        // 现状：FK 在行插入后自引用能成立，所以迁移会「成功」——但这条位置在树里不可达。
        // 这里只断言「不崩溃、数据条数完整、没有半截文件」；可见性问题在 C 组用双跑对照确认。
        expect.eq(result.code, 0, '当前实现对自环是宽容的（未报错）');
        const dbFile = path.join(dataDir, 'homebox.db');
        expect.eq(dbcheck.countRows(dbFile, 'locations'), 19, '位置数应完整');
        const cycled = dbcheck.query(dbFile,
          'SELECT id FROM locations WHERE id = parent_id');
        expect.eq(cycled.length, 1, '库内确实写进了 1 条自环');
        runner.finding('F-A10',
          '自环 parent 的 v1 数据能迁进来，但该位置在建树时不可达（整棵树可能变空）',
          'db.json 里 locations[i].parent = 自己时，迁移验收 ⑥ 只检查「父级存在」，自引用能通过；' +
          'buildTree 里这条位置自己当自己的子节点，永远不会成为根，也就永远不会被 decorate。' +
          '旧版 main 的 buildTree 逻辑与之逐行相同，所以两版表现一致（不是回归），' +
          '但如果环套在根节点上，GET /api/locations 会返回空树——建议迁移验收补一条「树可达性」检查。',
          'warn');
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A10' });

  runner.test('A11', '数组顺序不是父在前：迁移仍然成功、8 条验收全过、树结构与交付库等价',
    async () => {
      // 场景一：locations 整体倒序（每个子节点都排在它的父节点之前），
      // 并把「装着 3 件物品的格口 l_tvdrawer」挪到数组最后一位，
      // 顺带覆盖「items 引用的位置排在 locations 末尾」这条同类问题。
      const doc = clone(readSource(repoRoot));
      const reversed = doc.locations.slice().reverse();
      const at = reversed.findIndex((l) => l.id === 'l_tvdrawer');
      expect.ok(at !== -1, '样本里应能找到 l_tvdrawer');
      reversed.push(reversed.splice(at, 1)[0]);
      doc.locations = reversed;
      expect.eq(doc.locations[0].id, 'l_mvd5505ytbxrq', '倒序后第一个应是最深的格口');
      expect.eq(doc.locations[doc.locations.length - 1].id, 'l_tvdrawer',
        '有物品的格口应排在数组末尾');

      const { dir, dataDir, result } = migrateWith(repoRoot, doc);
      try {
        expect.eq(result.code, 0, '数据合法，只是数组顺序不同，退出码应为 0，实际 ' + result.code);
        expect.includes(result.stdout, '通过 8 / 8 条', '8 条验收应全过');
        expect.ok(!/FOREIGN KEY constraint failed/.test(result.stdout + result.stderr),
          '不应再出现即时外键失败');
        expect.ok(!fs.existsSync(path.join(dataDir, 'db.json')), 'db.json 应已改名留档');

        const dbFile = path.join(dataDir, 'homebox.db');
        expect.ok(fs.existsSync(dbFile), '应产出 homebox.db');
        expect.eq(dbcheck.countRows(dbFile, 'locations'), 19, '位置数');
        expect.eq(dbcheck.countRows(dbFile, 'items'), 26, '物品数');

        // 父子关系集合必须与源 JSON 完全一致（与数组顺序无关）
        const wantRel = doc.locations
          .map((l) => String(l.id) + '<-' + (l.parent ? String(l.parent) : 'ROOT'))
          .sort().join('|');
        const gotRel = dbcheck.locations(dbFile)
          .map((r) => String(r.id) + '<-' + (r.parent_id === null ? 'ROOT' : String(r.parent_id)))
          .sort().join('|');
        expect.eq(gotRel, wantRel, '父子关系集合');

        // 树可达性：恰好 1 个根，19 个节点全部从根可达，且深度正确
        const locs = dbcheck.locations(dbFile);
        const byId = new Map(locs.map((l) => [String(l.id), l]));
        const roots = locs.filter((l) => l.parent_id === null);
        expect.eq(roots.length, 1, '根节点数');
        expect.eq(String(roots[0].id), 'l_home', '根节点');
        const depthOf = (id) => {
          let d = 0;
          let cur = byId.get(id);
          while (cur && cur.parent_id !== null) { cur = byId.get(String(cur.parent_id)); d += 1; }
          return d;
        };
        const reachable = locs.filter((l) => {
          let cur = l;
          let guard = 0;
          while (cur && cur.parent_id !== null && guard < 64) { cur = byId.get(String(cur.parent_id)); guard += 1; }
          return !!cur && cur.parent_id === null;
        });
        expect.eq(reachable.length, 19, '从根可达的节点数应等于位置总数');
        expect.eq(depthOf('l_tvdrawer'), 3, 'l_tvdrawer 深度（家→客厅→电视柜→抽屉）');
        expect.eq(depthOf('l_mvd5505ytbxrq'), 3, 'l_mvd5505ytbxrq 深度（家→卧室→衣柜→抽屉）');

        // 最硬的一条：每件物品解析出来的 path 必须与交付的真实库逐字相同
        const pathOf = (dbPath) => {
          const rows = dbcheck.query(dbPath, 'SELECT id, loc_id FROM items');
          const map = new Map(dbcheck.locations(dbPath).map((l) => [String(l.id), l]));
          const walk = (locId) => {
            if (!locId) return '未归档';
            const parts = [];
            let cur = map.get(String(locId));
            let g = 0;
            while (cur && g < 32) {
              parts.unshift(String(cur.name));
              cur = cur.parent_id === null ? null : map.get(String(cur.parent_id));
              g += 1;
            }
            return parts.length ? parts.join(' › ') : '未归档';
          };
          return rows.map((r) => String(r.id) + '=' + walk(r.loc_id)).sort().join('|');
        };
        expect.eq(pathOf(dbFile), pathOf(path.join(repoRoot, 'data', 'homebox.db')),
          '每件物品解析出的 path 应与交付库完全一致');
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A11' });

  runner.test('A12', 'qty 非法：归 1 且在迁移报告里明确列出原值（不静默）', async () => {
    const doc = clone(readSource(repoRoot));
    doc.items[0].qty = 'abc';
    const { dir, dataDir, result } = migrateWith(repoRoot, doc);
    try {
      expect.eq(result.code, 0, '退出码（清洗不算失败）');
      const rows = dbcheck.items(path.join(dataDir, 'homebox.db'));
      expect.eq(Number(rows[0].qty), 1, 'qty 归一结果');
      // 清洗可以，但不能悄悄进行：报告里必须点名条数与原始值
      expect.includes(result.stdout, '[提示] 已修正 1 条非法数量', '报告应提示已修正条数');
      expect.includes(result.stdout, 'abc', '报告应列出原始值');
      expect.eq(dbcheck.countRows(path.join(dataDir, 'homebox.db'), 'items'), 26,
        '清洗不应影响条数');
    } finally {
      util.rmrf(dir);
    }
  }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A12' });

  runner.test('A13', '损坏库保护：homebox.db 是随机字节 → 拒绝启动、明确提示、退出码非 0',
    async () => {
      const dir = util.makeTempDir('hb-qa-corrupt-');
      const dataDir = path.join(dir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const dbFile = path.join(dataDir, 'homebox.db');
      const junk = Buffer.alloc(8192);
      for (let i = 0; i < junk.length; i += 1) junk[i] = (i * 37 + 11) % 256;
      fs.writeFileSync(dbFile, junk);
      const shaBefore = util.sha256File(dbFile);
      try {
        const run = servers.runNodeSync({
          cwd: repoRoot,
          args: [path.join(repoRoot, 'server.js')],
          env: { HB_DATA_DIR: dataDir, PORT: '0' },
          timeoutMs: 20000
        });
        expect.ok(run.code !== 0, '退出码应为非 0，实际 ' + run.code);
        const output = run.stdout + run.stderr;
        expect.includes(output, '[fatal]', '应有 [fatal] 提示');
        expect.includes(output, '数据库打不开', '提示应说明数据库打不开');
        expect.includes(output, 'data/backup/', '提示应给出恢复路径');
        expect.ok(output.indexOf('HomeBox 已启动') === -1, '绝不应该进入服务状态');
        // 关键：不能把坏库「修」成空库继续跑
        expect.eq(util.sha256File(dbFile), shaBefore, '坏库文件内容不应被改写');
        expect.eq(fs.statSync(dbFile).size, junk.length, '坏库文件不应被截断或替换');
        expect.ok(!fs.existsSync(dbFile + '-wal') || fs.statSync(dbFile + '-wal').size === 0,
          '不该留下有内容的 -wal');
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A13' });

  runner.test('A14', '损坏库 + 有 db.json：仍然拒绝启动，不会偷偷用示例数据顶替', async () => {
    const dir = util.makeTempDir('hb-qa-corrupt2-');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'homebox.db'), Buffer.alloc(4096, 7));
    fs.copyFileSync(path.join(repoRoot, 'data', 'db.json.migrated'), path.join(dataDir, 'db.json'));
    try {
      const run = servers.runNodeSync({
        cwd: repoRoot,
        args: [path.join(repoRoot, 'server.js')],
        env: { HB_DATA_DIR: dataDir, PORT: '0' },
        timeoutMs: 20000
      });
      expect.ok(run.code !== 0, '退出码应为非 0，实际 ' + run.code);
      expect.ok(fs.existsSync(path.join(dataDir, 'db.json')), 'db.json 必须原地保留');
      expect.eq(util.sha256File(path.join(dataDir, 'db.json')),
        util.sha256File(path.join(repoRoot, 'data', 'db.json.migrated')), 'db.json 内容不变');
    } finally {
      util.rmrf(dir);
    }
  }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A14' });

  runner.test('A15', '交付的真实库 data/homebox.db（复制后只读打开）与 db.json.migrated 逐字段一致',
    async () => {
      const src = readSource(repoRoot);
      const dir = util.makeTempDir('hb-qa-real-');
      try {
        const dbFile = copyRealDb(repoRoot, dir);
        const problems = compareDbWithSource(dbFile, src);
        if (problems.length) {
          throw new Error('真实库与源 JSON 不一致（' + problems.length + ' 处）：' +
            problems.slice(0, 12).join('；'));
        }
        expect.eq(dbcheck.countRows(dbFile, 'locations'), 19, '真实库位置数');
        expect.eq(dbcheck.countRows(dbFile, 'items'), 26, '真实库物品数');
        expect.eq(dbcheck.query(dbFile,
          'SELECT COUNT(*) AS c FROM items WHERE wear_json IS NOT NULL')[0].c, 14,
        '真实库衣物数');
        expect.eq(dbcheck.query(dbFile,
          'SELECT COUNT(*) AS c FROM items WHERE photo IS NOT NULL')[0].c, 1, '真实库照片数');
        expect.eq(Number(dbcheck.setting(dbFile, 'planWidthM')), 12, '真实库 planWidthM');
        // 真实库里的照片引用必须在 photos/ 目录里真的有文件
        const photo = String(dbcheck.query(dbFile,
          'SELECT photo FROM items WHERE photo IS NOT NULL')[0].photo);
        expect.ok(fs.existsSync(path.join(repoRoot, 'data', 'photos', photo)),
          '真实库引用的照片文件应存在：' + photo);
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A15' });

  runner.test('A16', 'bad JSON（这才是旧版最高危的路径）：拒绝迁移、绝不静默换成示例数据',
    async () => {
      const dir = util.makeTempDir('hb-qa-badjson-');
      const dataDir = path.join(dir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const broken = '{"version":2,"locations":[{"id":"l_home",';
      fs.writeFileSync(path.join(dataDir, 'db.json'), broken, 'utf8');
      util.copyDir(path.join(repoRoot, 'data', 'photos'), path.join(dataDir, 'photos'));
      try {
        const res = servers.runMigrate(repoRoot, dataDir);
        expect.ok(res.code !== 0, '退出码应为非 0，实际 ' + res.code);
        expect.includes(res.stdout + res.stderr, '无法解析', '错误提示应说明 JSON 无法解析');
        expect.includes(res.stdout, '真实数据一个字节都没有改动', '应明确告知数据未改动');
        expect.ok(!fs.existsSync(path.join(dataDir, 'homebox.db')), '不应产出 homebox.db');
        expect.eq(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'), broken,
          '坏文件必须原样保留，一个字节都不能改');
        // 关键：不能像旧版那样「坏文件 → 静默写示例数据」
        expect.eq(util.listFiles(dataDir).filter((f) => /^homebox\.db/.test(f)).length, 0,
          '不能有任何 homebox.db* 文件');
        runner.finding('F-A16',
          '坏 db.json 不再静默变成示例数据（这是旧版最危险的 bug，已修掉）',
          '旧版 readDB() 里 catch 到 JSON 解析失败会 `return seed()`，用户打开页面看到的是示例物品，' +
          '随手点一下编辑就把真实数据覆盖成种子数据，原文件永久丢失。' +
          '新版 readSource() 直接抛致命错误、进程 exit(1)、原文件保留、并在提示里指路 data/backup/。' +
          '这是 P1 最值得强调的改进。',
          'info');
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A16' });

  runner.test('A17', 'defer_foreign_keys 没有泄漏到运行期：同进程迁移后外键仍然拦得住',
    async () => {
      // 背景：为了让「子节点排在父节点前面」的合法 v1 数据也能迁移，
      // lib/migrate-v1.js 在迁移事务里开了 PRAGMA defer_foreign_keys = ON。
      // 这条 PRAGMA 理论上 COMMIT 后自动复位，但「server.js 同进程先迁移再服务」是最容易泄漏的路径：
      // 一旦真的泄漏，运行期的 ON DELETE SET NULL 会静默失效——删位置不再把物品置空，
      // 而且不会有任何报错，属于最难发现的一类回归。所以必须有一条常驻用例守着。
      const dir = util.makeTempDir('hb-qa-fkleak-');
      const dataDir = path.join(dir, 'data');
      servers.prepareDataDir(repoRoot, dataDir);
      // 注意：这里故意不预先跑迁移脚本，让 server.js 自己在同进程里完成迁移
      const srv = await servers.startNewServer({ repoRoot, dataDir });
      try {
        expect.includes(srv.stdout, '已从 data/db.json 迁移到 SQLite', '应走同进程迁移路径');

        const before = await httpc.request(srv.base, 'GET', '/api/items');
        const target = before.json.items.filter((i) => i.locId === 'l_tvdrawer')[0];
        expect.ok(target, '前置：l_tvdrawer 里应有物品');

        const del = await httpc.request(srv.base, 'DELETE', '/api/locations/l_tvdrawer');
        expect.eq(del.status, 200, '删位置状态码');
        expect.eq(del.json.removed, 1, '删位置条数');

        const after = await httpc.request(srv.base, 'GET', '/api/items');
        const gone = after.json.items.filter((i) => i.id === target.id)[0];
        expect.ok(gone, '物品不应被连带删除');
        expect.eq(gone.locId, null,
          '外键 ON DELETE SET NULL 必须仍然生效（locId 应被置空）—— 否则说明 ' +
          'defer_foreign_keys 泄漏到了运行期');
        expect.eq(gone.path, '未归档', 'path 应为未归档');

        // 再走一遍「建位置 → 放物品 → 删位置」，排除偶发
        const loc = await httpc.request(srv.base, 'POST', '/api/locations',
          { body: { name: '外键复核房间', kind: 'room' } });
        const locId = loc.json.location.id;
        const item = await httpc.request(srv.base, 'POST', '/api/items',
          { body: { name: '外键复核物品', locId } });
        expect.eq(item.json.item.locId, locId, '物品应落在新位置');
        await httpc.request(srv.base, 'DELETE', '/api/locations/' + encodeURIComponent(locId));
        const reread = await httpc.request(srv.base, 'GET', '/api/items');
        const it2 = reread.json.items.filter((i) => i.id === item.json.item.id)[0];
        expect.ok(it2, '第二个物品也应还在');
        expect.eq(it2.locId, null, '删位置后第二个物品的 locId 也应被置空');

        expect.ok(srv.stderr.indexOf('[fatal]') === -1, '不应有 [fatal]');
        expect.ok(srv.stderr.indexOf('[api error]') === -1,
          '不应有 [api error]：' + srv.stderr.slice(0, 300));
      } finally {
        await servers.stopServer(srv);
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A17' });

  runner.test('A18', '连接契约：lib/db.js 打开后的 5 条 PRAGMA 真的生效，且事务结束后自动复位',
    async () => {
      // 为什么要有这条：A17 是「行为层」的间接断言（靠 ON DELETE SET NULL 观察外键是否在线），
      // 这条是「配置层」的直接断言——直接读 PRAGMA，能一眼定位是谁把哪一项改坏了。
      //
      // 背景（实测过的事实，别搞混）：SQLite 原生 foreign_keys 默认 OFF，
      // 但 node:sqlite 的 DatabaseSync 在构造时默认 enableForeignKeyConstraints = true，
      // 所以「删掉那句 PRAGMA foreign_keys = ON」并不会立刻出问题——
      // 真正的失效路径是有人传 enableForeignKeyConstraints:false，或手动 PRAGMA OFF，
      // 或者将来 Node 改了这个默认值。这些情况本条用例都会红。
      //
      // 已知盲区（刻意保留，不是漏测）：下面 5 条里，
      //   journal_mode(wal vs delete) / busy_timeout(5000 vs 0) / synchronous(1 vs 2)
      //     → 删掉对应那行，本条会红；
      //   foreign_keys(1) / wal_autocheckpoint(1000)
      //     → 二者的默认值恰好就等于我们要的值，删掉那行读出来还是 1 / 1000，本条抓不到。
      // 但「删掉后行为不变」本身就不是回归，所以不补源码层 grep 那种脆弱断言。
      // 本条真正守的是「有人把这些值改成别的」以及「将来 Node 改默认值」——
      // 这两种情况读出来的值都会变，断言会红。
      //
      // 另：`:memory:` 库的 journal_mode 是 memory 而不是 wal，所以这里必须用真实文件；
      // 生产代码目前没有任何 :memory: 调用点。
      const dir = util.makeTempDir('hb-qa-pragma-');
      const file = path.join(dir, 'pragma.db');
      const db = require('../../lib/db');
      try {
        db.open(file);
        db.migrateSchema();
        const readOne = (sql) => {
          const row = db.get().prepare(sql).get();
          const key = Object.keys(row)[0];
          return Number(row[key]);
        };
        expect.eq(readOne('PRAGMA foreign_keys'), 1,
          'foreign_keys 必须为 1（否则 ON DELETE SET NULL 静默失效）');
        expect.eq(String(db.get().prepare('PRAGMA journal_mode').get().journal_mode), 'wal',
          'journal_mode 应为 wal');
        expect.eq(readOne('PRAGMA busy_timeout'), 5000, 'busy_timeout 应为 5000');
        expect.eq(readOne('PRAGMA synchronous'), 1, 'synchronous 应为 1(NORMAL)');
        expect.eq(readOne('PRAGMA wal_autocheckpoint'), 1000, 'wal_autocheckpoint 应为 1000');

        // defer_foreign_keys 必须是「事务内开、事务后自动复位」，否则会污染运行期
        expect.eq(readOne('PRAGMA defer_foreign_keys'), 0, '事务外 defer 应为 0');
        db.tx(() => {
          db.exec('PRAGMA defer_foreign_keys = ON');
          expect.eq(readOne('PRAGMA defer_foreign_keys'), 1, '事务内 defer 应为 1');
        });
        expect.eq(readOne('PRAGMA defer_foreign_keys'), 0, 'COMMIT 后 defer 必须回到 0');
        expect.eq(readOne('PRAGMA foreign_keys'), 1, 'COMMIT 后 foreign_keys 仍必须为 1');

        // 事务外再验一次「外键是即时校验的」：插一条悬空引用必须立刻失败
        db.get().exec('CREATE TABLE IF NOT EXISTS fk_probe (id TEXT PRIMARY KEY, ' +
          'pid TEXT REFERENCES fk_probe(id))');
        let rejected = false;
        try {
          db.get().prepare('INSERT INTO fk_probe (id, pid) VALUES (?, ?)').run('x', 'nope');
        } catch (err) {
          rejected = /FOREIGN KEY/i.test(err.message);
        }
        expect.ok(rejected, '事务外插入悬空外键必须被立刻拒绝（说明外键是即时校验的）');
      } finally {
        try { db.close(); } catch (err) { /* 已关 */ }
        util.rmrf(dir);
      }
    }, { repro: 'node --disable-warning=ExperimentalWarning qa/qa-p1.js --only A18' });
}

module.exports = { register, readSource, clone, migrateWith };

/**
 * A15 需要用到：把真实数据库（连同 -wal / -shm）复制到临时目录再读，
 * 全程不打开仓库里的 data/homebox.db，保证「只读真实数据」这条铁律。
 * @param {string} repoRoot 仓库根
 * @param {string} destDir 目标目录
 * @returns {string} 复制后的库文件路径
 */
function copyRealDb(repoRoot, destDir) {
  const src = path.join(repoRoot, 'data');
  fs.mkdirSync(destDir, { recursive: true });
  const dbFile = path.join(destDir, 'homebox.db');
  fs.copyFileSync(path.join(src, 'homebox.db'), dbFile);
  ['-wal', '-shm'].forEach((suffix) => {
    const from = path.join(src, 'homebox.db' + suffix);
    if (fs.existsSync(from)) fs.copyFileSync(from, dbFile + suffix);
  });
  return dbFile;
}

module.exports.copyRealDb = copyRealDb;
module.exports.compareDbWithSource = compareDbWithSource;
