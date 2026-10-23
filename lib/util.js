'use strict';

// HomeBox 通用小工具：时间、id、衣物字典与衣物清洗
// 全部从原 server.js 平移，逻辑一字未改，只补了 module.exports。

/* ---------- 衣物属性（衣柜模块） ----------
   衣物不单独建表，而是复用 items，额外挂一个可选的 wear 字段（v2 里是 wear_json 列）。
   好处：衣服本来就是家里的东西，能被全局搜索到，位置与路径逻辑完全复用。 */

const WEAR_TYPES = [
  { k: 'top', n: '上衣' },
  { k: 'bottom', n: '下装' },
  { k: 'outer', n: '外套' },
  { k: 'dress', n: '连衣裙' },
  { k: 'shoes', n: '鞋' },
  { k: 'accessory', n: '配饰' }
];

const WEAR_SEASONS = [
  { k: 'spring', n: '春' },
  { k: 'summer', n: '夏' },
  { k: 'autumn', n: '秋' },
  { k: 'winter', n: '冬' }
];

const WEAR_STATUS = [
  { k: 'ready', n: '可穿' },
  { k: 'laundry', n: '待洗' },
  { k: 'stored', n: '收起来了' }
];

// 户型默认宽度（米）：把抽象坐标换算成真实面积用，老数据缺这个字段时就取它
const DEFAULT_PLAN_WIDTH_M = 12;

/**
 * 在 {k,n} 字典里校验取值，不合法则返回兜底值。
 * @param {Array<{k:string,n:string}>} list 字典
 * @param {*} key 待校验值
 * @param {*} fallback 兜底值
 * @returns {*} 合法值或兜底值
 */
function validOf(list, key, fallback) {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].k === key) return key;
  }
  return fallback;
}

// 按月份粗略判断当季，南北差异大，所以前端允许用户手动切换季节
function seasonOfMonth(month) {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

/**
 * 把前端传来的 wear 对象洗成固定结构，字段顺序也与旧版一致（前端按字段名取值，顺序无影响）。
 * @param {*} raw 原始 wear
 * @returns {object|null} 清洗结果，非对象一律 null（调用方据此决定「不是衣服」）
 */
function sanitizeWear(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seasons = (Array.isArray(raw.seasons) ? raw.seasons : [])
    .map((s) => String(s))
    .filter((s) => validOf(WEAR_SEASONS, s, null) === s);
  return {
    type: validOf(WEAR_TYPES, raw.type, 'top'),
    seasons,
    colors: (Array.isArray(raw.colors) ? raw.colors : [])
      .map((c) => String(c).trim().slice(0, 16))
      .filter(Boolean).slice(0, 3),
    occasions: (Array.isArray(raw.occasions) ? raw.occasions : [])
      .map((c) => String(c).trim().slice(0, 16))
      .filter(Boolean).slice(0, 4),
    size: String(raw.size == null ? '' : raw.size).trim().slice(0, 20),
    status: validOf(WEAR_STATUS, raw.status, 'ready'),
    wearCount: Number(raw.wearCount) > 0 ? Math.floor(Number(raw.wearCount)) : 0,
    lastWorn: raw.lastWorn ? String(raw.lastWorn) : null
  };
}

// 距今多少天；空值或非法日期返回 null（前端据此显示「还没穿过」）
function daysSince(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

// 模块级自增，保证同一毫秒内生成的 id 也不会撞
let counter = 0;

/**
 * 生成 ID：前缀_时间戳36进制+自增+4位随机。
 * 形状必须保持不变 —— 旧 id（l_mvd5505yr6vah / i_mvcj9wd91uvkw）就是这个形状。
 * @param {string} prefix 'l' 位置、'i' 物品、'p' 照片
 * @returns {string}
 */
function genId(prefix) {
  counter += 1;
  return prefix + '_' + Date.now().toString(36) + counter.toString(36) +
    Math.random().toString(36).slice(2, 6);
}

function nowISO() {
  return new Date().toISOString();
}

/**
 * 把数字夹在 [min, max] 区间里。
 * @param {number} n 原值
 * @param {number} min 下界
 * @param {number} max 上界
 * @returns {number}
 */
function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/**
 * 把前端传来的 tags 归一成字符串数组。
 * 旧版在 POST / PUT 里各写了一遍，这里抽出来保证两条路径行为绝对一致：
 *   数组 → 逐项 trim 去空；其它（含逗号/中文逗号/空白分隔的字符串）→ 切分后 trim 去空。
 * @param {*} raw 原始 tags
 * @returns {string[]}
 */
function normalizeTags(raw) {
  const value = raw || [];
  if (Array.isArray(value)) {
    return value.map((x) => String(x).trim()).filter(Boolean);
  }
  return String(value).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

module.exports = {
  WEAR_TYPES,
  WEAR_SEASONS,
  WEAR_STATUS,
  DEFAULT_PLAN_WIDTH_M,
  validOf,
  seasonOfMonth,
  sanitizeWear,
  daysSince,
  genId,
  nowISO,
  clamp,
  normalizeTags
};
