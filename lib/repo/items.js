'use strict';

// 物品仓库：物品 CRUD + 搜索 + 衣物（wear）+ 照片关联 + 示例导入
//
// 几条必须守住的旧行为（前端完全不知情，改了就是回归）：
//   1. 每条 item 对外都带 path（「客厅 › 电视柜 › 左侧抽屉」），未归档是「未归档」；
//   2. GET /api/items 的 q 是子串匹配（大小写不敏感），匹配范围是 名称/备注/标签/路径；
//   3. 排序按 updatedAt 倒序，时间戳相同时保持插入顺序（旧版数组顺序）；
//   4. wear 整体存 JSON 列，对外仍是同一个对象；不是衣服的物品没有 wear 字段；
//   5. photo 只在有值时出现，没有照片时连 key 都没有（旧版是 delete item.photo）。

const db = require('../db');
const locations = require('./locations');
const members = require('./members');
const events = require('./events');
const {
  genId, nowISO, sanitizeWear, daysSince, normalizeTags
} = require('../util');

/* ---------- 行 → API 对象 ---------- */

/**
 * 解析 tags 列（JSON 数组文本）。坏数据退化成空数组，绝不让一个字段毁掉整个列表。
 * @param {*} raw 列值
 * @returns {string[]}
 */
function parseTags(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(String(raw));
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch (err) {
    return [];
  }
}

/**
 * 行 → 与旧版 db.json 完全同形的物品对象。
 * 注意：category / state / price_cents 等 P2 字段这里刻意不返回 ——
 * P1 的验收线是「返回结构 100% 不变」，字段要加也得等前端一起来。
 * @param {object} row items 表的行
 * @returns {object} API 形状的物品
 */
function rowToItem(row) {
  const out = {
    id: String(row.id),
    name: String(row.name),
    locId: row.loc_id === null ? null : String(row.loc_id),
    note: String(row.note),
    qty: Number(row.qty),
    tags: parseTags(row.tags)
  };
  if (row.wear_json) {
    try {
      out.wear = JSON.parse(String(row.wear_json));
    } catch (err) {
      // wear_json 坏了就当不是衣服，比抛错让整页打不开好
    }
  }
  out.createdAt = String(row.created_at);
  out.updatedAt = String(row.updated_at);
  // photo 放在最后，与旧版 db.json 里的字段顺序一致（前端按 key 取值，顺序本无影响，
  // 但能对上就别留无谓的差异，方便拿两份响应做逐字节比对回归）
  if (row.photo) out.photo = String(row.photo);

  // P2 新增字段统一追加在末尾，保证 P1 时代的字段前缀不变（便于差分回归）
  out.category = row.category == null ? null : String(row.category);
  out.state = row.state == null ? 'in_use' : String(row.state);
  out.ownerId = row.owner_id == null ? null : String(row.owner_id);
  // 金额一律整数分；未填价是 null 而不是 0 —— 「不知道多少钱」和「零元」是两件事
  out.priceCents = row.price_cents == null ? null : Number(row.price_cents);
  out.valueCents = row.price_cents == null ? null : Number(row.price_cents) * Number(row.qty);
  out.buyDate = row.buy_date == null ? null : String(row.buy_date);
  // P3：提醒相关字段。全部可为 null —— 空值表示「不提醒」，绝不给默认日期。
  out.expireAt = row.expire_at == null ? null : String(row.expire_at);
  out.remindDays = row.remind_days == null ? null : Number(row.remind_days);
  out.minQty = row.min_qty == null ? null : Number(row.min_qty);
  out.lendTo = row.lend_to == null ? null : String(row.lend_to);
  out.lendAt = row.lend_at == null ? null : String(row.lend_at);
  return out;
}

/**
 * 挂上 path 字段（path 永远排在最后，与旧版 Object.assign 追加的位置一致）。
 * @param {object} item API 形状的物品
 * @param {Map<string,{name:string,parent:string|null}>} index pathIndex() 的结果
 * @returns {object} 新对象，带 path
 */
function withPathFrom(item, index) {
  return Object.assign({}, item, { path: locations.pathOf(index, item.locId) });
}

// 排序与旧版一致：updated_at 倒序；同一时间戳按插入顺序（rowid 升序），
// 这样 13 件同秒导入的衣物顺序与迁移前完全相同。
const ORDER = ' ORDER BY updated_at DESC, rowid ASC';

/**
 * 取全部物品行。
 * @returns {object[]}
 */
function listRows() {
  return db.prepare('SELECT * FROM items' + ORDER).all();
}

function count() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM items').get();
  return Number(row ? row.c : 0);
}

/**
 * 取一件东西。
 * @param {string} id 物品 id
 * @returns {object|null} API 形状，没找到 null
 */
function get(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  return row ? rowToItem(row) : null;
}

/**
 * 单件挂 path（单条接口用；列表请用 list()，它会复用同一份位置索引）。
 * @param {object} item API 形状的物品
 * @returns {object} 带 path 的物品
 */
function withPath(item) {
  return withPathFrom(item, locations.pathIndex());
}

/**
 * 列表（等价于旧版 GET /api/items）。
 * @param {object} [opts] 选项
 * @param {string} [opts.q] 搜索词，子串匹配且大小写不敏感
 * @returns {object[]} 带 path 的物品数组，按 updatedAt 倒序
 */
function list(opts) {
  const cfg = opts || {};
  const q = String(cfg.q == null ? '' : cfg.q).trim().toLowerCase();
  const index = locations.pathIndex();
  const rows = listRows();
  let out = rows.map((row) => withPathFrom(rowToItem(row), index));
  // P2 筛选：只在调用方显式传了才生效，避免影响 P1 的行为
  if (cfg.ownerId !== undefined) {
    const want = String(cfg.ownerId);
    out = out.filter((i) => (i.ownerId || '') === want);
  }
  if (cfg.category !== undefined) {
    const want = String(cfg.category);
    out = out.filter((i) => (i.category || '') === want);
  }
  if (cfg.state !== undefined) {
    const want = String(cfg.state);
    out = out.filter((i) => (i.state || 'in_use') === want);
  }
  if (q) {
    out = out.filter((item) => {
      const hay = [item.name, item.note, (item.tags || []).join(' '), item.path]
        .join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  return out;
}

/**
 * 所有衣物（有 wear 的物品），带 path。
 * @returns {object[]} 物品数组，按 updatedAt 倒序
 */
function listWear() {
  const index = locations.pathIndex();
  return db.prepare('SELECT * FROM items WHERE wear_json IS NOT NULL' + ORDER).all()
    .map((row) => withPathFrom(rowToItem(row), index));
}

function countWear() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM items WHERE wear_json IS NOT NULL').get();
  return Number(row ? row.c : 0);
}

/* ---------- 写入 ---------- */

/**
 * 写入一行的通用语句（新建与示例导入共用）。
 * @param {object} item API 形状的物品
 * @param {string} createdAt 创建时间
 * @param {string} updatedAt 更新时间
 */
function insertItem(item, createdAt, updatedAt) {
  db.prepare('INSERT INTO items (id, name, loc_id, note, qty, category, expire_at, ' +
    'remind_days, min_qty, price_cents, buy_date, owner_id, state, lend_to, lend_at, ' +
    'photo, tags, wear_json, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(item.id, item.name, item.locId || null, item.note, item.qty,
      item.category || null, item.expireAt || null,
      item.remindDays == null ? null : item.remindDays,
      item.minQty == null ? null : item.minQty,
      item.priceCents == null ? null : item.priceCents,
      item.buyDate || null, item.ownerId || null, item.state || 'in_use',
      item.lendTo || null, item.lendAt || null,
      item.photo || null, JSON.stringify(item.tags || []),
      item.wear ? JSON.stringify(item.wear) : null, createdAt, updatedAt);
}

// 8 类受控类目（PRD）：自由标签仍然保留，类目只用于分类统计
const CATEGORIES = ['衣物', '食品', '药品', '日化', '工具', '电子', '文具', '其他'];

const STATES = ['in_use', 'used_up', 'lent', 'discarded'];

/**
 * 类目白名单收敛：不在 8 类里的一律落「其他」，空值表示未分类。
 * @param {*} raw 入参
 * @returns {string|null}
 */
function normalizeCategory(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  return CATEGORIES.indexOf(s) !== -1 ? s : '其他';
}

/**
 * 金额：对外一律整数分。非数字/负数当未填，不抛错（录入不该因为填错价格而失败）。
 * @param {*} raw 分值
 * @returns {number|null}
 */
function normalizePriceCents(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1e11) return null;   // 十亿元以上当误填
  return Math.round(n);
}

/**
 * 购入日期：只收 YYYY-MM-DD，其余当未填（绝不默认成今天）。
 * @param {*} raw 入参
 * @returns {string|null}
 */
function normalizeBuyDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * 状态白名单。
 * @param {*} raw 入参
 * @param {string} [fallback] 非法时回落值
 * @returns {string}
 */
function normalizeState(raw, fallback) {
  return STATES.indexOf(raw) !== -1 ? raw : (fallback || 'in_use');
}

/**
 * 日期（YYYY-MM-DD）或 null。绝不把「没填」默认成今天。
 * @param {*} raw 入参
 * @returns {string|null}
 */
function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * 小整数（0-3650）或 null。
 * @param {*} raw 入参
 * @param {number} max 上限
 * @returns {number|null}
 */
function normalizeSmallInt(raw, max) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(max, Math.floor(n));
}

/**
 * 新建物品。
 * @param {object} payload 前端入参
 * @returns {object} 带 path 的物品
 */
function create(payload) {
  const t = nowISO();
  // 位置不存在就当未归档：旧版会把非法 locId 原样存下来，
  // 但外键拦住了这条路；两条路对外的 path 都是「未归档」，用户看到的结果一致。
  const locId = payload.locId && locations.get(payload.locId) ? payload.locId : null;
  const ownerId = payload.ownerId && members.get(payload.ownerId) ? payload.ownerId : null;
  const item = {
    id: genId('i'),
    name: payload.name,
    locId,
    note: String(payload.note || ''),
    qty: Number.isFinite(Number(payload.qty)) && Number(payload.qty) > 0
      ? Number(payload.qty)
      : 1,
    tags: normalizeTags(payload.tags),
    category: normalizeCategory(payload.category),
    priceCents: normalizePriceCents(payload.priceCents),
    buyDate: normalizeBuyDate(payload.buyDate),
    ownerId,
    state: normalizeState(payload.state),
    expireAt: normalizeDate(payload.expireAt),
    remindDays: normalizeSmallInt(payload.remindDays, 60),
    minQty: normalizeSmallInt(payload.minQty, 100000),
    lendTo: payload.lendTo ? String(payload.lendTo).trim().slice(0, 20) : null,
    lendAt: null
  };
  // 新建时就是「借出」状态，从今天开始算借出时间
  if (item.state === 'lent') item.lendAt = t;
  // 带 wear 字段的就是一件衣服，会同时出现在衣柜模块里
  const wear = sanitizeWear(payload.wear);
  if (wear) item.wear = wear;

  return db.tx(() => {
    insertItem(item, t, t);
    events.log({
      itemId: item.id,
      kind: 'create',
      payload: { name: item.name, locId: item.locId, qty: item.qty }
    });
    return withPath(get(item.id));
  });
}

/**
 * 改物品。字段有无决定改不改，与旧版逐字段 if 的语义完全一致。
 * @param {string} id 物品 id
 * @param {object} payload 前端入参
 * @returns {object|null} 改后的物品，不存在返回 null
 */
function update(id, payload) {
  const cur = get(id);
  if (!cur) return null;

  const next = {
    name: payload.name !== undefined ? (String(payload.name).trim() || cur.name) : cur.name,
    locId: payload.locId !== undefined
      ? (payload.locId && locations.get(payload.locId) ? payload.locId : null)
      : cur.locId,
    note: payload.note !== undefined ? String(payload.note) : cur.note,
    qty: cur.qty,
    tags: cur.tags,
    wear: cur.wear || null,
    category: cur.category,
    priceCents: cur.priceCents,
    buyDate: cur.buyDate,
    ownerId: cur.ownerId,
    state: cur.state,
    expireAt: cur.expireAt,
    remindDays: cur.remindDays,
    minQty: cur.minQty,
    lendTo: cur.lendTo,
    lendAt: cur.lendAt
  };

  if (payload.category !== undefined) next.category = normalizeCategory(payload.category);
  // 金额允许显式清空（传 null 或空串 = 改回「未记录」）
  if (payload.priceCents !== undefined) next.priceCents = normalizePriceCents(payload.priceCents);
  if (payload.buyDate !== undefined) next.buyDate = normalizeBuyDate(payload.buyDate);
  if (payload.ownerId !== undefined) {
    next.ownerId = payload.ownerId && members.get(payload.ownerId) ? payload.ownerId : null;
  }
  if (payload.state !== undefined) next.state = normalizeState(payload.state, cur.state);
  if (payload.expireAt !== undefined) next.expireAt = normalizeDate(payload.expireAt);
  if (payload.remindDays !== undefined) next.remindDays = normalizeSmallInt(payload.remindDays, 60);
  if (payload.minQty !== undefined) next.minQty = normalizeSmallInt(payload.minQty, 100000);
  if (payload.lendTo !== undefined) {
    next.lendTo = payload.lendTo ? String(payload.lendTo).trim().slice(0, 20) : null;
  }

  // 借出时间：刚变成「借出」时记下今天，还回来就清掉，免得留下过期的借出记录
  if (next.state === 'lent' && cur.state !== 'lent') next.lendAt = nowISO();
  if (next.state !== 'lent') {
    next.lendAt = null;
    next.lendTo = null;
  }

  if (payload.qty !== undefined) {
    const n = Number(payload.qty);
    if (Number.isFinite(n) && n > 0) next.qty = n;
  }
  if (payload.tags !== undefined) {
    next.tags = normalizeTags(payload.tags);
  }
  if (payload.wear !== undefined) {
    const wear = sanitizeWear(payload.wear);
    if (wear) {
      // 编辑表单可能不带穿着历史，这里保留原值
      wear.wearCount = Math.max(
        Number.isFinite(Number(payload.wear.wearCount)) ? Number(payload.wear.wearCount) : 0,
        Number(cur.wear && cur.wear.wearCount) || 0
      );
      wear.lastWorn = payload.wear.lastWorn || (cur.wear && cur.wear.lastWorn) || null;
      next.wear = wear;
    } else {
      next.wear = null;
    }
  }

  const updatedAt = nowISO();
  return db.tx(() => {
    db.prepare('UPDATE items SET name = ?, loc_id = ?, note = ?, qty = ?, tags = ?, ' +
      'wear_json = ?, category = ?, price_cents = ?, buy_date = ?, owner_id = ?, ' +
      'state = ?, expire_at = ?, remind_days = ?, min_qty = ?, lend_to = ?, lend_at = ?, ' +
      'updated_at = ? WHERE id = ?')
      .run(next.name, next.locId, next.note, next.qty, JSON.stringify(next.tags),
        next.wear ? JSON.stringify(next.wear) : null, next.category, next.priceCents,
        next.buyDate, next.ownerId, next.state, next.expireAt, next.remindDays,
        next.minQty, next.lendTo, next.lendAt, updatedAt, id);
    events.log({ itemId: id, kind: 'update', payload: { name: next.name } });
    if (cur.priceCents !== next.priceCents) {
      events.log({ itemId: id, kind: 'price', payload: { from: cur.priceCents, to: next.priceCents } });
    }
    if (cur.ownerId !== next.ownerId) {
      events.log({ itemId: id, kind: 'owner', payload: { from: cur.ownerId, to: next.ownerId } });
    }
    if (cur.state !== next.state) {
      events.log({ itemId: id, kind: 'state', payload: { from: cur.state, to: next.state } });
    }
    if (cur.locId !== next.locId) {
      events.log({ itemId: id, kind: 'move', payload: { from: cur.locId, to: next.locId } });
    }
    if (cur.qty !== next.qty) {
      events.log({ itemId: id, kind: 'qty', payload: { from: cur.qty, to: next.qty } });
    }
    return withPath(get(id));
  });
}

/**
 * 删物品。照片文件由调用方在事务提交后再删（文件删失败不能拖累数据）。
 * @param {string} id 物品 id
 * @returns {object|null} 被删掉的物品（调用方据此删照片），不存在返回 null
 */
function remove(id) {
  const gone = get(id);
  if (!gone) return null;
  db.tx(() => {
    // events 由 ON DELETE CASCADE 一起清掉
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
  });
  return gone;
}

/**
 * 记录一张新照片（换图时旧的由调用方删文件）。
 * @param {string} id 物品 id
 * @param {string} file 文件名
 * @returns {object|null} 改后的物品
 */
function setPhoto(id, file) {
  const cur = get(id);
  if (!cur) return null;
  const updatedAt = nowISO();
  return db.tx(() => {
    db.prepare('UPDATE items SET photo = ?, updated_at = ? WHERE id = ?')
      .run(file, updatedAt, id);
    events.log({ itemId: id, kind: 'photo', payload: { from: cur.photo || null, to: file } });
    return get(id);
  });
}

/**
 * 清掉照片字段（不删文件，文件名由调用方拿走再删）。
 * @param {string} id 物品 id
 * @returns {object|null} 改后的物品
 */
function clearPhoto(id) {
  const cur = get(id);
  if (!cur) return null;
  const updatedAt = nowISO();
  return db.tx(() => {
    db.prepare('UPDATE items SET photo = NULL, updated_at = ? WHERE id = ?')
      .run(updatedAt, id);
    events.log({ itemId: id, kind: 'photo', payload: { from: cur.photo || null, to: null } });
    return get(id);
  });
}

/**
 * 记录「今天穿了」/ 撤销。穿过的默认转「待洗」。
 * @param {string} id 物品 id
 * @param {object} [opts] 入参
 * @param {boolean} [opts.undo] 撤销上一次
 * @param {boolean} [opts.laundry] 传 false 表示不改状态
 * @returns {{error?:{status:number,error:string}, item?:object, restored?:object}}
 */
function logWear(id, opts) {
  const cfg = opts || {};
  const cur = get(id);
  if (!cur) return { error: { status: 404, error: '找不到这件东西' } };
  if (!cur.wear) return { error: { status: 400, error: '它不是衣服' } };

  const prior = cur.wear.wearCount || 0;
  const priorWorn = cur.wear.lastWorn || null;
  const wear = Object.assign({}, cur.wear);
  if (cfg.undo) {
    wear.wearCount = Math.max(0, prior - 1);
    wear.lastWorn = null;
  } else {
    wear.wearCount = prior + 1;
    wear.lastWorn = nowISO();
    if (cfg.laundry !== false) wear.status = 'laundry';
  }
  const updatedAt = nowISO();

  return db.tx(() => {
    db.prepare('UPDATE items SET wear_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(wear), updatedAt, id);
    events.log({
      itemId: id,
      kind: 'wear',
      payload: { undo: !!cfg.undo, wearCount: wear.wearCount }
    });
    return {
      item: withPath(get(id)),
      restored: { wearCount: prior, lastWorn: priorWorn }
    };
  });
}

/* ---------- 示例衣物清单 ---------- */

// 首次安装时写入 seed，已存在的数据库则通过 demo 接口按需导入。
// slot 只说明「习惯放哪」，导入时会按用户实际的位置结构柔性匹配。
/**
 * 示例衣物清单。
 * @returns {object[]} 示例定义
 */
function demoWearSpec() {
  return [
    { name: '白色基础款 T 恤', slot: 'hanging', type: 'top',
      seasons: ['spring', 'summer', 'autumn'], colors: ['white'], size: 'M', occasions: ['休闲'] },
    { name: '藏青薄针织衫', slot: 'hanging', type: 'top',
      seasons: ['spring', 'autumn', 'winter'], colors: ['navy'], size: 'M',
      occasions: ['通勤', '休闲'], note: '通勤常穿的那件' },
    { name: '浅灰连帽卫衣', slot: 'fold', type: 'top',
      seasons: ['spring', 'autumn', 'winter'], colors: ['gray'], size: 'L', occasions: ['休闲'] },
    { name: '条纹长袖衬衫', slot: 'hanging', type: 'top',
      seasons: ['spring', 'autumn'], colors: ['white', 'navy'], size: 'M', occasions: ['通勤'] },
    { name: '深蓝直筒牛仔裤', slot: 'fold', type: 'bottom',
      seasons: ['spring', 'autumn', 'winter'], colors: ['denim'], size: '32', occasions: ['休闲'] },
    { name: '卡其休闲裤', slot: 'fold', type: 'bottom',
      seasons: ['spring', 'summer', 'autumn'], colors: ['khaki'], size: '32', occasions: ['通勤'] },
    { name: '西装外套', slot: 'hanging', type: 'outer',
      seasons: ['spring', 'autumn'], colors: ['black'], size: 'M',
      occasions: ['正式'], note: '面试、正式场合才穿' },
    { name: '米色长款风衣', slot: 'hanging', type: 'outer',
      seasons: ['autumn', 'winter', 'spring'], colors: ['beige'], size: 'M', occasions: ['通勤', '休闲'] },
    { name: '深灰羽绒服', slot: 'hanging', type: 'outer',
      seasons: ['winter'], colors: ['gray'], size: 'M', occasions: ['休闲'], note: '过冬用，很厚' },
    { name: '白色运动鞋', slot: 'shoes', type: 'shoes',
      seasons: ['spring', 'summer', 'autumn'], colors: ['white'], size: '42', occasions: ['休闲'] },
    { name: '棕色皮鞋', slot: 'shoes', type: 'shoes',
      seasons: ['spring', 'autumn', 'winter'], colors: ['brown'], size: '42', occasions: ['正式'] },
    { name: '灰色羊毛围巾', slot: 'drawer', type: 'accessory',
      seasons: ['winter'], colors: ['gray'], size: '', occasions: ['休闲'] },
    { name: '厚毛衣（冬）', slot: 'top-shelf', type: 'top',
      seasons: ['winter'], colors: ['beige'], size: 'M', occasions: ['休闲'],
      note: '夏天用真空袋收起来了', status: 'stored' },
    { name: '待洗的白衬衫', slot: 'laundry', type: 'top',
      seasons: ['spring', 'summer', 'autumn'], colors: ['white'], size: 'M',
      occasions: ['通勤'], note: '沾了油渍，送干洗', status: 'laundry' }
  ];
}

/**
 * 把一条示例定义变成物品对象（不落库）。
 * @param {object} spec 示例定义
 * @param {string|null} locId 位置 id
 * @param {string} t 时间戳
 * @returns {object} API 形状的物品
 */
function wearToItem(spec, locId, t) {
  return {
    id: genId('i'),
    name: spec.name,
    locId,
    note: spec.note || '',
    qty: 1,
    tags: [],
    wear: {
      type: spec.type,
      seasons: spec.seasons || [],
      colors: spec.colors || [],
      occasions: spec.occasions || [],
      size: spec.size || '',
      status: spec.status || 'ready',
      wearCount: 0,
      lastWorn: null
    },
    createdAt: t,
    updatedAt: t
  };
}

/**
 * 往用户真实的衣柜结构里塞一批示例衣物（POST /api/wardrobe/demo）。
 * @returns {{error?:{status:number,error:string}, added?:number, wardrobe?:string}}
 */
function importDemoWear() {
  const has = countWear();
  if (has) {
    return { error: { status: 409, error: '已经有 ' + has + ' 件衣服了，不需要再导入示例' } };
  }
  const locs = locations.list();
  if (!locs.length) {
    return { error: { status: 400, error: '先去「记一件」里建一个收纳位置' } };
  }

  const t = nowISO();
  const findByName = (re) => locs.find((l) => re.test(l.name));
  const wardrobe = findByName(/衣柜|衣橱|衣帽间/) || findByName(/卧室|卧房/) || locs[0];

  return db.tx(() => {
    const ensureChild = (name) => locations.ensureChild(wardrobe.id, name);
    const hanging = ensureChild('挂衣区');
    const fold = ensureChild('叠放区');
    const drawer = ensureChild('抽屉');
    const shoesLoc = (findByName(/鞋柜|鞋架/) || wardrobe).id;
    const topShelfLoc = findByName(/顶层|隔板|收纳箱|储物箱/) || wardrobe;

    const slotMap = {
      hanging,
      fold,
      drawer,
      shoes: shoesLoc,
      'top-shelf': topShelfLoc.id,
      laundry: drawer
    };
    const added = demoWearSpec().map((spec) => {
      const locId = slotMap[spec.slot] ||
        (spec.status === 'stored' ? topShelfLoc.id : hanging);
      return wearToItem(spec, locId, t);
    });

    added.forEach((item) => {
      insertItem(item, t, t);
      events.log({ itemId: item.id, kind: 'create', payload: { demo: true, name: item.name } });
    });

    return { added: added.length, wardrobe: wardrobe.name };
  });
}

/**
 * 把 idleDays（上次穿着距今多少天）算进 wear 对象里，衣柜页要显示它。
 * @param {object} item API 形状的物品（必须带 wear）
 * @returns {object} 新对象
 */
function withIdleDays(item) {
  return Object.assign({}, item, {
    wear: Object.assign({}, item.wear, { idleDays: daysSince(item.wear.lastWorn) })
  });
}

module.exports = {
  CATEGORIES,
  STATES,
  parseTags,
  rowToItem,
  normalizeCategory,
  normalizePriceCents,
  normalizeBuyDate,
  normalizeState,
  normalizeDate,
  normalizeSmallInt,
  withPath,
  listRows,
  list,
  count,
  get,
  listWear,
  countWear,
  create,
  update,
  remove,
  setPhoto,
  clearPhoto,
  logWear,
  demoWearSpec,
  wearToItem,
  importDemoWear,
  withIdleDays,
  insertItem
};
