'use strict';

// 响应归一化与差异定位。
//
// 新旧两版对比时，id / 时间戳必然不同（新版 id 是新生成的、时间戳取当前时刻），
// 所以先做一次「按首次出现顺序」的占位替换，把结构问题暴露出来、把随机值抹平。

/**
 * 新建一次归一化上下文。
 * @returns {{ids: Map<string,string>, counters: Record<string,number>}}
 */
function newContext() {
  return { ids: new Map(), counters: { loc: 0, item: 0, photo: 0 } };
}

/**
 * 给某类 id 分配稳定占位符。
 * @param {object} ctx 上下文
 * @param {'loc'|'item'|'photo'} kind 类别
 * @param {string} value 原始 id
 * @returns {string} 占位符
 */
function placeholder(ctx, kind, value) {
  const key = kind + ':' + value;
  if (!ctx.ids.has(key)) {
    ctx.counters[kind] += 1;
    ctx.ids.set(key, '<' + kind + '#' + ctx.counters[kind] + '>');
  }
  return ctx.ids.get(key);
}

/**
 * 按字段名决定这个值要不要抹平。
 * @param {object} ctx 上下文
 * @param {string} key 字段名
 * @param {*} value 值
 * @returns {*} 处理后的值
 */
function maskField(ctx, key, value) {
  if (value === null || value === undefined) return value;
  if (key === 'createdAt' || key === 'updatedAt' || key === 'lastWorn' || key === 'at') {
    return '<ts>';
  }
  if (typeof value !== 'string') return value;
  if (key === 'id') {
    if (/^l_/.test(value)) return placeholder(ctx, 'loc', value);
    if (/^i_/.test(value)) return placeholder(ctx, 'item', value);
    if (/^p_/.test(value)) return placeholder(ctx, 'photo', value);
    return value;
  }
  if (key === 'locId' || key === 'parent') return placeholder(ctx, 'loc', value);
  if (key === 'photo') return placeholder(ctx, 'photo', value);
  return value;
}

/**
 * 递归归一化一整棵响应。
 * @param {*} value 原始值
 * @param {object} ctx 上下文（newContext()）
 * @returns {*} 归一化结果
 */
function canon(value, ctx) {
  if (Array.isArray(value)) return value.map((v) => canon(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v && typeof v === 'object') {
        out[key] = key === 'id' ? v : canon(v, ctx);
      } else {
        out[key] = maskField(ctx, key, v);
      }
    }
    return out;
  }
  return value;
}

/**
 * 递归收集两棵结构的差异。
 * @param {*} a 旧值
 * @param {*} b 新值
 * @param {string} [prefix] 路径前缀
 * @param {Array} [out] 累积数组
 * @returns {Array<{path:string, old:*, new:*}>}
 */
function diff(a, b, prefix, out) {
  const acc = out || [];
  const where = prefix || '';
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) {
    acc.push({ path: where || '(root)', old: typeName(a), new: typeName(b) });
    return acc;
  }
  if (aIsArr) {
    if (a.length !== b.length) {
      acc.push({ path: where + '.length', old: a.length, new: b.length });
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) diff(a[i], b[i], where + '[' + i + ']', acc);
    return acc;
  }
  const aIsObj = a && typeof a === 'object';
  const bIsObj = b && typeof b === 'object';
  if (aIsObj !== bIsObj) {
    acc.push({ path: where || '(root)', old: typeName(a), new: typeName(b) });
    return acc;
  }
  if (aIsObj) {
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const key of keys) {
      const p = where ? where + '.' + key : key;
      if (!(key in a)) { acc.push({ path: p, old: '(缺字段)', new: a2s(b[key]) }); continue; }
      if (!(key in b)) { acc.push({ path: p, old: a2s(a[key]), new: '(缺字段)' }); continue; }
      diff(a[key], b[key], p, acc);
    }
    return acc;
  }
  if (a !== b) acc.push({ path: where || '(root)', old: a, new: b });
  return acc;
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function a2s(v) {
  if (v && typeof v === 'object') return Array.isArray(v) ? '[…]' : '{…}';
  return v;
}

/**
 * 只描述「形状」（键名 + 类型），用于随机内容（如搭配建议）。
 * @param {*} value 值
 * @returns {*} 形状描述
 */
function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length ? [shape(value[0])] : [];
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = shape(value[key]);
    return out;
  }
  return typeof value;
}

/**
 * 把差异列表渲染成可读文本。
 * @param {Array} diffs diff() 的结果
 * @param {number} [limit] 最多显示几条
 * @returns {string}
 */
function render(diffs, limit) {
  const max = limit || 12;
  const head = diffs.slice(0, max).map((d) =>
    '  · ' + d.path + '：旧 ' + a2s(d.old) + ' → 新 ' + a2s(d.new));
  const tail = diffs.length > max ? ['  · …还有 ' + (diffs.length - max) + ' 处'] : [];
  return head.concat(tail).join('\n');
}

module.exports = { newContext, canon, diff, shape, render };
