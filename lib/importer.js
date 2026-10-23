'use strict';

// 导出 / 回灌
//
// 导出的就是「人类可读的一整份数据」，和 scripts/export.js 同形，也可以直接回灌。
// 回灌是**破坏性操作**：先自动备份，再在一个事务里整体替换，失败就回滚到原样。

const db = require('./db');
const backup = require('./backup');
const { nowISO } = require('./util');

/**
 * 把一份导出的文档读进数据库（整体替换）。
 *
 * 为什么要先按深度排序：外键是即时校验的，子位置排在父位置前面会直接失败。
 * 迁移脚本用的是 `PRAGMA defer_foreign_keys`，这里沿用同一个办法，
 * 但排序本身仍然做一遍 —— 万一以后关掉延迟校验也不至于崩。
 *
 * @param {object} doc 导出文档
 * @param {object} opts 选项
 * @param {string} opts.dataDir 数据目录（回灌前会在这里留一份备份）
 * @returns {{error?:{status:number,error:string}, counts?:object, backupFile?:string}}
 */
function importAll(doc, opts) {
  if (!doc || typeof doc !== 'object') {
    return { error: { status: 400, error: '内容不是一份有效的导出文件' } };
  }
  if (!Array.isArray(doc.locations) || !Array.isArray(doc.items)) {
    return { error: { status: 400, error: '文件里缺少 locations 或 items' } };
  }
  if (doc.items.length > 20000 || doc.locations.length > 5000) {
    return { error: { status: 400, error: '数据量太大，超出了单次导入的上限' } };
  }

  // 位置按「父在前」排序：深度小的先插
  const byId = new Map();
  doc.locations.forEach((l) => {
    if (l && l.id) byId.set(String(l.id), l);
  });
  const depthOf = (l, guard) => {
    let d = 0;
    let cur = l;
    let n = 0;
    while (cur && cur.parent && byId.has(String(cur.parent)) && n < 64) {
      cur = byId.get(String(cur.parent));
      d += 1;
      n += 1;
    }
    return guard ? d : d;
  };
  const ordered = doc.locations.slice().sort((a, b) => depthOf(a) - depthOf(b));

  const snapshot = opts && opts.dataDir
    ? backup.run({ dataDir: opts.dataDir, reason: 'pre-import' })
    : null;

  const now = nowISO();
  try {
    db.tx(() => {
      db.exec('PRAGMA defer_foreign_keys = ON');
      db.exec('DELETE FROM items');
      db.exec('DELETE FROM events');
      db.exec('DELETE FROM locations');

      const insLoc = db.prepare('INSERT INTO locations (id, name, parent_id, kind, ' +
        'box_x, box_y, box_w, box_h, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      ordered.forEach((l, i) => {
        const box = l.box || {};
        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
        insLoc.run(String(l.id), String(l.name || '未命名'),
          l.parent ? String(l.parent) : null,
          ['home', 'room', 'furniture', 'compartment'].indexOf(l.kind) !== -1 ? l.kind : 'compartment',
          num(box.x), num(box.y), num(box.w), num(box.h),
          Number.isFinite(Number(l.sortOrder)) ? Number(l.sortOrder) : i,
          String(l.createdAt || now));
      });

      const insItem = db.prepare('INSERT INTO items (id, name, loc_id, note, qty, category, ' +
        'expire_at, remind_days, min_qty, price_cents, buy_date, owner_id, state, lend_to, ' +
        'lend_at, photo, tags, wear_json, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      doc.items.forEach((it) => {
        if (!it || !it.id) return;
        const qty = Number(it.qty);
        insItem.run(String(it.id), String(it.name || '未命名'),
          it.locId ? String(it.locId) : null,
          String(it.note || ''),
          Number.isFinite(qty) && qty > 0 ? qty : 1,
          it.category ? String(it.category) : null,
          it.expireAt ? String(it.expireAt) : null,
          Number.isFinite(Number(it.remindDays)) ? Number(it.remindDays) : null,
          Number.isFinite(Number(it.minQty)) ? Number(it.minQty) : null,
          Number.isFinite(Number(it.priceCents)) ? Number(it.priceCents) : null,
          it.buyDate ? String(it.buyDate) : null,
          it.ownerId ? String(it.ownerId) : null,
          ['in_use', 'used_up', 'lent', 'discarded'].indexOf(it.state) !== -1 ? it.state : 'in_use',
          it.lendTo ? String(it.lendTo) : null,
          it.lendAt ? String(it.lendAt) : null,
          it.photo ? String(it.photo) : null,
          JSON.stringify(Array.isArray(it.tags) ? it.tags : []),
          it.wear ? JSON.stringify(it.wear) : null,
          String(it.createdAt || now), String(it.updatedAt || now));
      });
    });
  } catch (err) {
    return {
      error: { status: 400, error: '导入失败，已回滚：' + (err.message || err) },
      backupFile: snapshot ? snapshot.file : null
    };
  }

  return {
    counts: { locations: ordered.length, items: doc.items.length },
    backupFile: snapshot ? snapshot.file : null
  };
}

module.exports = { importAll };
