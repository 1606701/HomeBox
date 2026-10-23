'use strict';

// 拍照识别：把一张照片变成「预填草稿」
//
// 三条纪律（DECISIONS D4）：
//   1. **可关、默认可关**：没配 Key 时接口返回 404，前端根本不渲染拍照按钮；
//   2. **失败不挡路**：超时/限流/返回坏 JSON 一律 200 + unavailable，前端只出一行灰字，
//      表单照常能用 —— 识别是加速器，不是流程的一部分；
//   3. **三件事拆开**：提示词、白名单收敛、JSON 校验。用户明说效果不好会再来调，
//      换模型/改提示词不能牵动另外两件。
//
// 不引任何 SDK：各家都是 OpenAI 兼容的 /chat/completions，内置 fetch 就够。

const items = require('./repo/items');
const locations = require('./repo/locations');

const TIMEOUT_MS = 6000;
const MAX_NAME = 30;
const MAX_TAGS = 3;

/**
 * 提示词。想调识别效果，改这里就够了，别动下面的收敛逻辑。
 * @param {string[]} roomNames 现有的房间名，供模型挑一个
 * @returns {string} 提示词
 */
function buildPrompt(roomNames) {
  const cats = items.CATEGORIES.join('、');
  const rooms = roomNames.length ? roomNames.join('、') : '（无）';
  return [
    '你是家庭收纳助手。看照片里最主要的那件物品，输出一个 JSON 对象，不要输出任何其他文字。',
    '字段要求：',
    '  name: 物品名称，2-12 个汉字，写具体一点（"5号电池" 而不是 "电池"）；',
    '  category: 必须从这些里选一个：' + cats + '；',
    '  tags: 0-3 个中文短标签的数组（例如 ["耗材","备用"]）；',
    '  location: 从这些房间名里挑最可能放它的一个：' + rooms + '，实在判断不了就给 null；',
    '  confident: 你有多大把握，0 到 1 的小数。',
    '只输出 JSON，不要 markdown 代码块，不要解释。'
  ].join('\n');
}

/**
 * 从模型回复里抠出 JSON（有些模型会包一层 ```json）。
 * @param {string} text 模型原始输出
 * @returns {object|null} 解析结果
 */
function parseModelJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(body.slice(start, end + 1));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (err) {
    return null;
  }
}

/**
 * 白名单收敛：模型说的话只能当建议，落库前必须符合我们自己的规则。
 * @param {object} draft 模型输出
 * @param {string[]} roomNames 房间名
 * @returns {object} 干净的草稿
 */
function sanitize(draft, roomNames) {
  const out = { name: '', category: null, tags: [], locationName: null, confident: 0 };
  if (!draft) return out;

  out.name = String(draft.name == null ? '' : draft.name).trim().slice(0, MAX_NAME);

  const cat = String(draft.category == null ? '' : draft.category).trim();
  out.category = items.CATEGORIES.indexOf(cat) !== -1 ? cat : '其他';

  if (Array.isArray(draft.tags)) {
    out.tags = draft.tags
      .map((t) => String(t == null ? '' : t).trim().slice(0, 8))
      .filter(Boolean)
      .slice(0, MAX_TAGS);
  }

  const loc = String(draft.location == null ? '' : draft.location).trim();
  out.locationName = roomNames.indexOf(loc) !== -1 ? loc : null;

  const c = Number(draft.confident);
  out.confident = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
  return out;
}

/**
 * 调一次视觉模型。
 * @param {object} cfg AI 配置
 * @param {string} dataUrl 图片 data URL
 * @param {string} prompt 提示词
 * @returns {Promise<object>} 草稿
 */
async function callModel(cfg, dataUrl, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(String(cfg.baseUrl).replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.1,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }]
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('识别服务返回 ' + res.status + '：' + body.slice(0, 160));
    }
    const json = await res.json();
    const text = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : '';
    return { parsed: parseModelJson(text), raw: text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 识别一张图。
 * @param {string} image 图片（data URL 或纯 base64）
 * @param {object} cfg AI 配置（baseUrl/model/apiKey/timeoutMs）
 * @returns {Promise<{ok:boolean, draft?:object, unavailable?:boolean, hint?:string, error?:string}>}
 */
async function recognize(image, cfg) {
  const raw = String(image || '');
  if (!raw) return { ok: false, error: '没有收到图片' };
  const dataUrl = raw.indexOf('data:') === 0
    ? raw
    : ('data:image/jpeg;base64,' + raw.replace(/^base64,/, ''));

  // 只把房间名给模型挑，不给整棵树 —— 省 token，也避免它编出不存在的楼层
  const roomNames = locations.list().filter((l) => l.kind === 'room').map((l) => l.name);

  let result;
  try {
    result = await callModel(cfg, dataUrl, buildPrompt(roomNames));
  } catch (err) {
    const aborted = err.name === 'AbortError';
    return {
      ok: false,
      unavailable: true,
      hint: aborted ? '识别超时了，先手动记吧' : '识别暂不可用，先手动记'
    };
  }

  const draft = sanitize(result.parsed, roomNames);
  if (!draft.name) {
    return { ok: false, unavailable: true, hint: '没认出是什么，先手动记吧' };
  }
  return { ok: true, draft };
}

module.exports = {
  TIMEOUT_MS,
  buildPrompt,
  parseModelJson,
  sanitize,
  recognize
};
