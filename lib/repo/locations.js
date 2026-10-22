'use strict';

// 位置仓库：位置树 CRUD + 自动摆放坐标 + 防环 + 户型设置
//
// 坐标体系（旧逻辑原样平移）：box 是统一平面坐标，0–100 的画布，
// 房间与家具共用一套坐标；格口（抽屉、隔板）不画在地图上，所以 box 为空。
//
// 数据库里 box 拆成 box_x/box_y/box_w/box_h 四列（热力/面积要靠 SQL 算），
// 但对外 API 仍然是 {x,y,w,h} 对象 —— 前端一个字节都不用改。

const db = require('../db');
const { genId, nowISO, DEFAULT_PLAN_WIDTH_M } = require('../util');

const KINDS = ['home', 'room', 'furniture', 'compartment'];

const PLAN_W = 100;
const PLAN_H = 88;

/* ---------- 行 → API 对象 ---------- */

/**
 * 四列 REAL 还原成 {x,y,w,h}；四列全空返回 null（格口就是这种）。
 * @param {object} row locations 表的行
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function rowToBox(row) {
  if (row.box_x === null && row.box_y === null && row.box_w === null && row.box_h === null) {
    return null;
  }
  return {
    x: Number(row.box_x),
    y: Number(row.box_y),
    w: Number(row.box_w),
    h: Number(row.box_h)
  };
}

/**
 * 行 → 与旧版 db.json 完全同形的位置对象。
 * @param {object} row locations 表的行
 * @returns {{id:string,name:string,parent:string|null,kind:string,box:object|null,createdAt:string}}
 */
function rowToLocation(row) {
  return {
    id: String(row.id),
    name: String(row.name),
    parent: row.parent_id === null ? null : String(row.parent_id),
    kind: String(row.kind),
    box: rowToBox(row),
    createdAt: String(row.created_at)
  };
}

/**
 * 把外部传进来的 box 洗干净：必须是 {x,y,w,h} 四个有限数字，否则当没有。
 * 比旧版更严一点点（旧版会把 {} 原样存下来，前端拿到会算出 NaN），
 * 但合法输入下的结果与旧版逐位相同（REAL 就是双精度，浮点精度不丢）。
 * @param {*} raw 原始 box
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function normalizeBox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
      !Number.isFinite(w) || !Number.isFinite(h)) {
    return null;
  }
  return { x, y, w, h };
}

/* ---------- 查询 ---------- */

// 树与列表顺序必须与旧 JSON 数组顺序一致，所以按 sort_order 排（迁移时写入旧数组下标）
const ORDER = ' ORDER BY sort_order ASC, rowid ASC';

/**
 * 全部位置，按旧数组顺序。
 * @returns {object[]} locations 表的行
 */
function listRows() {
  return db.prepare('SELECT * FROM locations' + ORDER).all();
}

/**
 * 全部位置，API 形状。
 * @returns {object[]}
 */
function list() {
  return listRows().map(rowToLocation);
}

function count() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM locations').get();
  return Number(row ? row.c : 0);
}

/**
 * 按 id 取一个位置。
 * @param {string} id 位置 id
 * @returns {object|null} API 形状，没找到 null
 */
function get(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  return row ? rowToLocation(row) : null;
}

/**
 * 一次性把「id → {id,name,parent}」装进 Map。
 * 路径拼接要反复向上找父节点，逐个查库会退化成 N 次查询，所以必须先建索引。
 * @returns {Map<string,{id:string,name:string,parent:string|null}>}
 */
function pathIndex() {
  const map = new Map();
  for (const row of db.prepare('SELECT id, name, parent_id FROM locations').all()) {
    map.set(String(row.id), {
      id: String(row.id),
      name: String(row.name),
      parent: row.parent_id === null ? null : String(row.parent_id)
    });
  }
  return map;
}

/**
 * 位置全路径，如「客厅 › 电视柜 › 左侧抽屉」。分隔符是全角空格包着的 ›，前端按它显示。
 * @param {Map<string,{name:string,parent:string|null}>} index pathIndex() 的结果
 * @param {string|null} locId 位置 id
 * @returns {string} 路径，无位置或找不到时为「未归档」
 */
function pathOf(index, locId) {
  if (!locId) return '未归档';
  const parts = [];
  let cur = index.get(locId);
  let guard = 0;
  while (cur && guard < 32) {
    parts.unshift(cur.name);
    cur = cur.parent ? index.get(cur.parent) : null;
    guard += 1;
  }
  return parts.length ? parts.join(' › ') : '未归档';
}

/* ---------- 树 ---------- */

/**
 * 建位置树。itemCount 是直辖物品数，totalCount 含所有子孙位置的合计。
 * @returns {object[]} 根节点数组
 */
function buildTree() {
  const rows = listRows();
  const counts = {};
  for (const row of db.prepare('SELECT loc_id, COUNT(*) AS c FROM items ' +
    'WHERE loc_id IS NOT NULL GROUP BY loc_id').all()) {
    counts[String(row.loc_id)] = Number(row.c);
  }

  const nodes = new Map();
  for (const row of rows) {
    nodes.set(String(row.id), {
      id: String(row.id),
      name: String(row.name),
      kind: String(row.kind),
      parent: row.parent_id === null ? null : String(row.parent_id),
      box: rowToBox(row),
      children: []
    });
  }

  const roots = [];
  for (const node of nodes.values()) {
    // 父节点找不到（理论上 FK 挡住了，这里留个兜底）就当成根，和旧版一致
    const parent = node.parent ? nodes.get(node.parent) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const decorate = (node) => {
    node.itemCount = counts[node.id] || 0;
    node.children.forEach(decorate);
    // totalCount 把子位置也算进来，地图上看到的是这一处的合计持有量
    node.totalCount = node.itemCount + node.children.reduce((s, c) => s + (c.totalCount || 0), 0);
    return node;
  };
  return roots.map(decorate);
}

/* ---------- 防环 ---------- */

/**
 * nodeId 是否是 ancestorId 的后代。
 * @param {string} ancestorId 潜在祖先
 * @param {string} nodeId 待测节点
 * @returns {boolean} 是后代返回 true
 */
function isDescendant(ancestorId, nodeId) {
  const index = pathIndex();
  let cur = index.get(nodeId);
  let guard = 0;
  while (cur && guard < 64) {
    if (cur.parent === ancestorId) return true;
    cur = cur.parent ? index.get(cur.parent) : null;
    guard += 1;
  }
  return false;
}

/* ---------- 自动摆放（旧逻辑逐行平移，浮点常量一个没动） ---------- */

// 两个矩形是否有重叠
function overlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

/**
 * 新房间：细网格扫描找空位，尺寸逐级缩小；始终保证落在画布内。
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function autoRoomBox() {
  const rooms = listRows()
    .filter((l) => l.kind === 'room' && l.box_x !== null)
    .map(rowToBox);
  const sizes = [[28, 22], [24, 18], [20, 15], [16, 12]];
  for (let s = 0; s < sizes.length; s += 1) {
    const w = sizes[s][0];
    const h = sizes[s][1];
    for (let y = 1; y + h <= PLAN_H - 1; y += 2) {
      for (let x = 1; x + w <= PLAN_W - 1; x += 2) {
        const box = { x, y, w, h };
        if (!rooms.some((l) => overlaps(box, l))) return box;
      }
    }
  }
  // 实在挤满了：挑重叠最少的角落，绝不能放到画布外面让人看不见
  const w = 20;
  const h = 15;
  let best = { x: 1, y: 1, w, h };
  let bestArea = Infinity;
  for (let y = 1; y + h <= PLAN_H - 1; y += 3) {
    for (let x = 1; x + w <= PLAN_W - 1; x += 3) {
      const box = { x, y, w, h };
      const area = rooms.reduce((sum, l) => sum + overlapArea(box, l), 0);
      if (area < bestArea) { bestArea = area; best = box; }
    }
  }
  return best;
}

/**
 * 新家具：落在父房间内，避开同屋其他家具。
 * @param {string|null} parentId 父位置 id
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function autoFurnitureBox(parentId) {
  const parentRow = parentId
    ? db.prepare('SELECT * FROM locations WHERE id = ?').get(parentId)
    : null;
  const parentBox = parentRow ? rowToBox(parentRow) : null;
  const base = parentBox || { x: 4, y: 4, w: 30, h: 24 };
  const fw = Math.max(6, Math.min(14, base.w * 0.32));
  const fh = Math.max(5, Math.min(11, base.h * 0.22));
  const sibs = listRows()
    .filter((l) => l.parent_id === (parentId || null) && l.box_x !== null)
    .map(rowToBox);
  const cols = Math.max(2, Math.floor((base.w - 2) / (fw + 1.2)));
  for (let i = 0; i < 24; i += 1) {
    const box = {
      x: base.x + 1.5 + (i % cols) * (fw + 1.2),
      y: base.y + 5 + Math.floor(i / cols) * (fh + 1.2),
      w: fw, h: fh
    };
    if (box.y + box.h > base.y + base.h - 0.5) break;
    if (!sibs.some((l) => overlaps(box, l))) return box;
  }
  // 房间塞满了：贴着房间左上角放，并保证不出画布
  return {
    x: Math.min(base.x + 1.5, PLAN_W - fw - 0.5),
    y: Math.min(base.y + 5, PLAN_H - fh - 0.5),
    w: fw, h: fh
  };
}

/* ---------- 写入 ---------- */

function nextSortOrder() {
  const row = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM locations').get();
  return Number(row ? row.m : 0) + 1;
}

/**
 * 新建位置。
 * @param {object} input 入参
 * @param {string} input.name 名称（已 trim，调用方保证非空）
 * @param {string} input.kind home/room/furniture/compartment
 * @param {string|null} input.parent 父位置 id
 * @param {object|null} input.box 坐标，可为空
 * @returns {object} API 形状的位置对象
 */
function create(input) {
  const parentId = input.parent && get(input.parent) ? input.parent : null;
  const box = normalizeBox(input.box);
  const id = genId('l');
  const createdAt = nowISO();
  db.prepare('INSERT INTO locations (id, name, parent_id, kind, ' +
    'box_x, box_y, box_w, box_h, sort_order, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.name, parentId, input.kind,
      box ? box.x : null, box ? box.y : null, box ? box.w : null, box ? box.h : null,
      nextSortOrder(), createdAt);
  return get(id);
}

/**
 * 改位置。只更新 patch 里出现的字段，与旧版「按字段有无分别改」的语义一致。
 * @param {string} id 位置 id
 * @param {object} patch 允许 name / box / parent / kind
 * @returns {object|null} 改后的位置，不存在返回 null
 */
function update(id, patch) {
  const row = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  if (!row) return null;
  const cur = rowToLocation(row);
  const next = {
    name: patch.name !== undefined ? patch.name : cur.name,
    parent: patch.parent !== undefined ? patch.parent : cur.parent,
    kind: patch.kind !== undefined ? patch.kind : cur.kind,
    box: patch.box !== undefined ? patch.box : cur.box
  };
  const box = normalizeBox(next.box);
  // 上游已经校验过「不能挂到自己下面 / 不能挂到自己的下级里 / 上级位置不存在」，
  // 这里只做一道 FK 兜底：父节点真的不存在就当成没挂。
  const parentId = next.parent && get(next.parent) ? next.parent : null;
  db.prepare('UPDATE locations SET name = ?, parent_id = ?, kind = ?, ' +
    'box_x = ?, box_y = ?, box_w = ?, box_h = ? WHERE id = ?')
    .run(next.name, parentId, next.kind,
      box ? box.x : null, box ? box.y : null, box ? box.w : null, box ? box.h : null, id);
  return get(id);
}

/**
 * 收集一个位置连同它所有子孙的 id（顺序为从深到浅，便于先删叶子）。
 * @param {string} id 根位置 id
 * @returns {string[]} id 数组
 */
function collectSubtree(id) {
  const childrenOf = new Map();
  for (const row of db.prepare('SELECT id, parent_id FROM locations').all()) {
    const pid = row.parent_id === null ? null : String(row.parent_id);
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push(String(row.id));
  }
  const out = [];
  const walk = (target) => {
    out.push(target);
    const kids = childrenOf.get(target) || [];
    kids.forEach(walk);
  };
  walk(id);
  return out;
}

/**
 * 删除一批位置。物品不会被删，loc_id 由外键 ON DELETE SET NULL 自动置空
 * （与旧版「删位置时把物品标成未归档」完全一致）。
 * @param {string[]} idList 位置 id 数组
 * @returns {number} 实际删除的行数
 */
function removeMany(idList) {
  const list = Array.isArray(idList) ? idList.filter(Boolean) : [];
  if (!list.length) return 0;
  const stmt = db.prepare('DELETE FROM locations WHERE id = ?');
  let removed = 0;
  // 反序删（先叶子后父节点），避免中途出现父节点已删、子节点还在的窗口
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const res = stmt.run(list[i]);
    removed += Number(res.changes || 0);
  }
  return removed;
}

/**
 * 确保某个父位置下存在同名子位置，没有就建一个格口。
 * 衣柜示例导入用它凑出「挂衣区 / 叠放区 / 抽屉」。
 * @param {string} parentId 父位置 id
 * @param {string} name 子位置名
 * @returns {string} 子位置 id
 */
function ensureChild(parentId, name) {
  const row = db.prepare('SELECT id FROM locations WHERE parent_id = ? AND name = ?')
    .get(parentId, name);
  if (row) return String(row.id);
  return create({ name, kind: 'compartment', parent: parentId, box: null }).id;
}

/* ---------- 户型设置（跟着位置树一起返回，所以放在这个仓库里） ---------- */

/**
 * 读户型设置。planWidthM 对外必须是数字（旧版就是 number），所以这里做一次转换。
 * @returns {{planWidthM:number}}
 */
function loadSettings() {
  const raw = db.getSetting('planWidthM', null);
  const m = Number(raw);
  return { planWidthM: (Number.isFinite(m) && m > 0) ? m : DEFAULT_PLAN_WIDTH_M };
}

/**
 * 保存户型宽度，保留一位小数（旧版 Math.round(m*10)/10，语义不变）。
 * @param {number} meters 家的宽度（米）
 * @returns {{planWidthM:number}} 保存后的设置
 */
function savePlanWidthM(meters) {
  const rounded = Math.round(Number(meters) * 10) / 10;
  db.setSetting('planWidthM', rounded);
  return loadSettings();
}

module.exports = {
  KINDS,
  PLAN_W,
  PLAN_H,
  rowToBox,
  rowToLocation,
  normalizeBox,
  listRows,
  list,
  count,
  get,
  pathIndex,
  pathOf,
  buildTree,
  isDescendant,
  overlaps,
  overlapArea,
  autoRoomBox,
  autoFurnitureBox,
  create,
  update,
  collectSubtree,
  removeMany,
  ensureChild,
  loadSettings,
  savePlanWidthM
};
