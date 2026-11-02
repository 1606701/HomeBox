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
const { WEAR_TYPES, COLORS, normalizeColors } = require('./util');

const TIMEOUT_MS = 12000;
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
  const wears = COLORS_TYPES_HINT();
  const colors = colorHint();
  return [
    '你是家庭收纳助手。看照片里最主要的那件物品，输出一个 JSON 对象，不要输出任何其他文字。',
    '字段要求：',
    '  name: 物品名称，2-14 个汉字。**如果看得出颜色或材质，一定写进名称里**（写「深灰直筒裤」而不是「裤子」，写「白色运动鞋」而不是「鞋」）；',
    '  category: 必须从这些里选一个：' + cats + '；',
    '  wearType: 当 category 是「衣物」时必填，从这些里选一个：' + wears + '；不是衣物就给 null；',
    '  colors: 0-3 个颜色，只能从这些键里选：' + colors + '。看不清就给空数组，不要猜；',
    '  tags: 0-3 个中文短标签的数组（例如 ["耗材","备用"]）；',
    '  location: 从这些房间名里挑最可能放它的一个：' + rooms + '，实在判断不了就给 null；',
    '  confident: 你有多大把握，0 到 1 的小数。',
    '只输出 JSON，不要 markdown 代码块，不要解释。'
  ].join('\n');
}

/**
 * 衣物类型提示串：top(上衣)、bottom(下装)…
 * @returns {string}
 */
function COLORS_TYPES_HINT() {
  return WEAR_TYPES.map((t) => t.k + '(' + t.n + ')').join('、');
}

/**
 * 颜色提示串：black(黑)、white(白)…
 * @returns {string}
 */
function colorHint() {
  return COLORS.map((c) => c.k + '(' + c.n + ')').join('、');
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
  const out = {
    name: '', category: null, tags: [], locationName: null, confident: 0,
    wearType: null, colors: []
  };
  if (!draft) return out;

  out.name = String(draft.name == null ? '' : draft.name).trim().slice(0, MAX_NAME);

  const cat = String(draft.category == null ? '' : draft.category).trim();
  out.category = items.CATEGORIES.indexOf(cat) !== -1 ? cat : '其他';

  // 只有衣物才有类型和颜色，别的类目一律清空 —— 免得「工具」被塞个 wearType
  if (out.category === '衣物') {
    const wt = String(draft.wearType == null ? '' : draft.wearType).trim();
    out.wearType = WEAR_TYPES.some((t) => t.k === wt) ? wt : null;
    out.colors = normalizeColors(draft.colors);
  }

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
 * 调一次视觉模型，主模型排队时自动换备用模型。
 *
 * 免费 Flash 档在高峰经常回 `1305 该模型当前访问量过大`，这既不是 Key 问题也不是我们限流。
 * 策略：主模型试一次（429 再试一次），仍然 429 就换 fallbackModel（默认 glm-4v-flash，
 * 也是永免费的视觉模型，只是老一代）；两个都忙才降级成一行灰字。
 * @param {object} cfg AI 配置
 * @param {string} dataUrl 图片 data URL
 * @param {string} prompt 提示词
 * @returns {Promise<object>} 草稿
 */
async function callModel(cfg, dataUrl, prompt) {
  const body = (model) => JSON.stringify({
    model,
    temperature: 0.1,
    // 有些视觉模型会先「想一想」（reasoning_content），token 给太少会全被思考吃掉、
    // 正式回答一个字没有。这些模型的上限是 1024，取满。
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }]
  });
  const url = String(cfg.baseUrl).replace(/\/$/, '') + '/chat/completions';

  const attempt = async (model, withFormat) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || TIMEOUT_MS);
    try {
      const payload = JSON.parse(body(model));
      // 结构化输出：模型严格按 JSON 回，省掉「它写了一段散文」这类失败
      if (withFormat) payload.response_format = { type: 'json_object' };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error('识别服务返回 ' + res.status + '：' + text.slice(0, 160));
        err.status = res.status;
        err.model = model;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const models = [cfg.model, cfg.fallbackModel].filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastErr = null;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    for (let round = 0; round < 2; round += 1) {
      try {
        let json;
        try {
          json = await attempt(model, true);
        } catch (err) {
          // 只有「不认 response_format」才值得去掉参数重来；
          // 别的 400（比如 max_tokens 超范围）重试也没用，直接抛。
          if (err.status === 400 && /response_format|json_object/i.test(err.message)) {
            json = await attempt(model, false);
          } else {
            throw err;
          }
        }
        const msg = json && json.choices && json.choices[0] && json.choices[0].message;
        // content 为空时退回 reasoning_content：推理型视觉模型偶尔把答案写在思考里
        const text = msg ? (msg.content || msg.reasoning_content || '') : '';
        return { parsed: parseModelJson(text), raw: text, modelUsed: model };
      } catch (err) {
        lastErr = err;
        // 只有「排队太挤」值得重试/换模型；Key 不对、地址不对重试也没用
        if (err.status !== 429) throw err;
        await new Promise((r) => setTimeout(r, round === 0 ? 900 : 300));
      }
    }
  }
  throw lastErr || new Error('识别失败');
}

/**
 * 把「调用模型时炸了」翻译成一行给用户看的话。
 *
 * 降级是对的，但「为什么降级」得能看出来，否则同一条灰字下，
 * Key 填错了和网线拔了看起来一模一样，用户只能靠猜。
 * @param {Error} err 抛出来的错误
 * @returns {{ok:false, unavailable:true, hint:string, detail:object}}
 */
function degrade(err) {
  const msg = String(err && err.message || '');
  const detail = { error: msg.slice(0, 200) };
  if (err && err.name === 'AbortError') {
    return { ok: false, unavailable: true, hint: '识别超时了，先手动记吧', detail };
  }
  if (/ 401| 403/.test(msg)) {
    return { ok: false, unavailable: true, hint: '识别服务不认这个 Key（检查是否复制完整、是否已实名）', detail };
  }
  if (/ 429/.test(msg)) {
    return { ok: false, unavailable: true, hint: '识别服务现在很忙（免费档高峰常这样），过一会儿再试', detail };
  }
  if (/ 404/.test(msg)) {
    return { ok: false, unavailable: true, hint: '接口地址或模型名不对（404）', detail };
  }
  return { ok: false, unavailable: true, hint: '识别暂不可用，先手动记吧', detail };
}

/**
 * 把 data URL / 纯 base64 统一成 data URL。
 * @param {string} image 图片
 * @returns {string}
 */
function toDataUrl(image) {
  const raw = String(image || '');
  return raw.indexOf('data:') === 0
    ? raw
    : ('data:image/jpeg;base64,' + raw.replace(/^base64,/, ''));
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
  const dataUrl = toDataUrl(raw);

  // 只把房间名给模型挑，不给整棵树 —— 省 token，也避免它编出不存在的楼层
  const roomNames = locations.list().filter((l) => l.kind === 'room').map((l) => l.name);

  let result;
  try {
    result = await callModel(cfg, dataUrl, buildPrompt(roomNames));
  } catch (err) {
    return degrade(err);
  }

  const draft = sanitize(result.parsed, roomNames);
  if (!draft.name) {
    // 把模型原话截一小段带回去：出问题时能一眼看出是「它说了散文」还是「图里确实没东西」
    return {
      ok: false,
      unavailable: true,
      hint: '没认出是什么，先手动记吧',
      detail: { model: result.modelUsed, raw: String(result.raw || '').slice(0, 120) }
    };
  }
  return { ok: true, draft, model: result.modelUsed };
}

/* ==================== 保质期识别（拍标签） ====================
 *
 * 和上面的「认东西」共用 callModel / parseModelJson / degrade，但纪律更硬：
 * 认错一件东西，用户看一眼照片就知道；认错一个日期，它会被当成真的存进家里，
 * 然后三个月后在一个完全错误的早上提醒你「牛奶明天到期」。
 *
 * 所以这里的信任基础不是准确率，是**可核对**：
 *   - 模型必须把它实际读到的原文抄回来（rawText），人一眼能对；
 *   - 只认标签上印着的东西，看不出来就是 null，由代码决定算不出就整条作废；
 *   - 到期日一律在服务端算（生产日期 + 保质期），不接受模型自己算好的结果。
 * 前端把这三个值并排显示，用户对不上就直接改 —— 自动填，但绝不自动信。
 */

// 只有这三类真的在意保质期；衣物工具电子没有，不给按钮
const EXPIRY_CATEGORIES = ['食品', '药品', '日化'];
const MAX_SHELF_MONTHS = 120;   // 10 年，再长基本是识别错了
const MAX_SHELF_DAYS = 3650;
const MAX_RAW_TEXT = 60;
const MAX_FUTURE_YEARS = 50;    // 印着 2206 年到期，一定是把 2 看成 3 了

/**
 * 保质期提示词。
 *
 * 「宁可返回 null 也不要猜」这句重复了三遍，不是啰嗦：视觉模型在这种结构化小任务上
 * 最大的失败模式不是读错，而是**编**——看到一个日期格式的空位就忍不住填。
 * @returns {string} 提示词
 */
function buildExpiryPrompt() {
  return [
    '照片是一件商品的包装或标签。任务只有一个：找出**生产日期**和**保质期**。',
    '输出一个 JSON 对象，不要输出任何其他文字。字段：',
    '  rawText: 把你实际读到的那一小段原始文字照抄下来（含数字和单位，最多 40 字）。没读到就填空字符串；',
    '  productionDate: 生产日期，格式 YYYY-MM-DD。标签上写「20260815」「2026/08/15」「2026年8月15日」都要归一成这个格式；没有就填 null；',
    '  expireDate: 标签上**直接印的**到期日（「保质期至」「有效期至」「此日期前食用最佳」后面的那个日期），格式 YYYY-MM-DD；没有就填 null；',
    '  shelfLifeMonths: 保质期，单位是「月」时填这个数字（「保质期 12 个月」→ 12，「18月」→ 18）；单位不是月就填 null；',
    '  shelfLifeDays: 保质期，单位是「天」时填这个数字（「保质期 7 天」→ 7）；单位不是天就填 null；',
    '  confident: 你有多大把握，0 到 1 的小数。',
    '铁律：只填你在照片里真正看见的东西。看不清、被遮挡、包装上没印，一律填 null。',
    '不要根据商品常识推断保质期；不要根据今天的日期倒推生产日期；不要填一个「看起来像样」的日期。',
    '宁可整段都是 null，也不要猜。猜错的日期会被当成真的存进这个家里。',
    '只输出 JSON，不要 markdown 代码块，不要解释。'
  ].join('\n');
}

/**
 * 两位补零。
 * @param {number} n 数字
 * @returns {string}
 */
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * 某年某月有几天。
 * @param {number} y 年
 * @param {number} m 月（1-12）
 * @returns {number}
 */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * 这个年月日是否真实存在（挡掉 2026-02-30 这类模型笔误）。
 * @param {number} y 年
 * @param {number} m 月
 * @param {number} d 日
 * @returns {boolean}
 */
function isRealDate(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/**
 * 把各种写法收敛成 YYYY-MM-DD，认不出或日期不存在都返回 null。
 * @param {string} v 原始值
 * @returns {string|null}
 */
function normDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  let y; let mo; let d;
  const sep = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (sep) {
    y = Number(sep[1]); mo = Number(sep[2]); d = Number(sep[3]);
  } else if (compact) {
    y = Number(compact[1]); mo = Number(compact[2]); d = Number(compact[3]);
  } else {
    return null;
  }
  if (!isRealDate(y, mo, d)) return null;
  return y + '-' + pad2(mo) + '-' + pad2(d);
}

/**
 * 日期加自然月。月末溢出退回当月最后一天：1月31日 + 1个月 = 2月28日。
 * 这不是近似，是保质期的通行算法（包装上「保质期 1 个月」按日历月算）。
 * @param {string} ymd YYYY-MM-DD
 * @param {number} n 月数
 * @returns {string|null}
 */
function addMonths(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (!isRealDate(y, mo, d)) return null;
  const total = y * 12 + (mo - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12 + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return ny + '-' + pad2(nm) + '-' + pad2(nd);
}

/**
 * 日期加天数。
 * @param {string} ymd YYYY-MM-DD
 * @param {number} n 天数
 * @returns {string|null}
 */
function addDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (!isRealDate(y, mo, d)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d) + n * 86400000);
  return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}

/**
 * 从「12个月」「12」这类值里取一个范围内的整数，取不到返回 null。
 * @param {*} v 原始值
 * @param {number} min 下限（含）
 * @param {number} max 上限（含）
 * @returns {number|null}
 */
function normInt(v, min, max) {
  if (v == null || v === '') return null;
  // 模型有时把单位一起塞进来（"12个月"），能救就救，救不了算 null
  const n = Math.round(Number(String(v).replace(/[^\d.-]/g, '')));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * 收敛成「一个可以用、且知道自己是怎么来的」到期日。
 * @param {object} draft 模型输出
 * @param {string} [today] 今天 YYYY-MM-DD，缺省取系统日期
 * @returns {object} {rawText, productionDate, shelfLifeMonths, shelfLifeDays, expireDate, derived, confident}
 */
function sanitizeExpiry(draft, today) {
  const now = normDate(today) || new Date().toISOString().slice(0, 10);
  const out = {
    rawText: '', productionDate: null, shelfLifeMonths: null, shelfLifeDays: null,
    expireDate: null, derived: false, confident: 0
  };
  if (!draft || typeof draft !== 'object') return out;

  out.rawText = String(draft.rawText == null ? '' : draft.rawText)
    .replace(/\s+/g, ' ').trim().slice(0, MAX_RAW_TEXT);

  // 生产日期：未来的一律作废（模型爱把到期日写进生产日期这一栏）
  let prod = normDate(draft.productionDate);
  if (prod && prod > now) prod = null;
  out.productionDate = prod;

  out.shelfLifeMonths = normInt(draft.shelfLifeMonths, 1, MAX_SHELF_MONTHS);
  out.shelfLifeDays = normInt(draft.shelfLifeDays, 1, MAX_SHELF_DAYS);
  // 两个都填了就只认月：留两个会算出两个互相矛盾的到期日，说不清哪个对
  if (out.shelfLifeMonths) out.shelfLifeDays = null;

  const computed = () => {
    if (!prod) return null;
    if (out.shelfLifeMonths) return addMonths(prod, out.shelfLifeMonths);
    if (out.shelfLifeDays) return addDays(prod, out.shelfLifeDays);
    return null;
  };

  // 标签上直接印的到期日最权威，优先用；没有才拿生产日期 + 保质期算
  let expire = normDate(draft.expireDate);
  if (expire) {
    const limit = (Number(now.slice(0, 4)) + MAX_FUTURE_YEARS) + '-12-31';
    // 印着 50 年后到期，几乎一定是把数字看错了
    if (expire > limit) expire = null;
  }
  // 到期日必须晚于生产日期；违反说明至少有一个看错了，退回自己算的
  if (expire && prod && expire <= prod) expire = computed();
  if (!expire) expire = computed();
  // 算出来的仍然不晚于生产日期，就是彻底说不通，整条作废
  if (expire && prod && expire <= prod) expire = null;

  out.expireDate = expire || null;
  out.derived = !!expire && normDate(draft.expireDate) !== expire;

  const c = Number(draft.confident);
  let conf = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
  // 推算出来的比直接读到的多绕了一步，把握上限压下来，
  // 让前端那句「对一下实物」在推算结果上更容易出现
  if (out.derived) conf = Math.min(conf, 0.75);
  out.confident = Math.round(conf * 100) / 100;
  return out;
}

/**
 * 识别标签上的生产日期 / 保质期，返回一个算好了的到期日。
 *
 * 只回到期日，不回生产日期和保质期：用户手上那张包装会扔，数据库里留一个
 * 「不知道谁算的」生产日期没有意义，反而将来会被当成用户亲手填的事实。
 * 中间值只用于前端那行核对文字。
 * @param {string} image 图片（data URL 或纯 base64）
 * @param {object} cfg AI 配置
 * @param {string} [today] 今天 YYYY-MM-DD，测试用
 * @returns {Promise<object>} {ok, expiry?, model?, unavailable?, hint?, detail?}
 */
async function recognizeExpiry(image, cfg, today) {
  const raw = String(image || '');
  if (!raw) return { ok: false, error: '没有收到图片' };

  let result;
  try {
    result = await callModel(cfg, toDataUrl(raw), buildExpiryPrompt());
  } catch (err) {
    return degrade(err);
  }

  const expiry = sanitizeExpiry(result.parsed, today);
  if (!expiry.expireDate) {
    // 分两种说：读到一半和完全没读到。前者告诉用户「少个保质期」，
    // 后者就是这张图不对（拍糊了、拍的是一面白底、拍的压根不是标签）
    const hint = expiry.productionDate
      ? '看到了生产日期，但没找到保质期，先手动填吧'
      : '标签上没找到日期，先手动填吧';
    return {
      ok: false,
      unavailable: true,
      hint,
      detail: {
        model: result.modelUsed,
        rawText: expiry.rawText,
        raw: String(result.raw || '').slice(0, 120)
      }
    };
  }
  return { ok: true, expiry, model: result.modelUsed };
}

module.exports = {
  TIMEOUT_MS,
  EXPIRY_CATEGORIES,
  buildPrompt,
  buildExpiryPrompt,
  parseModelJson,
  sanitize,
  sanitizeExpiry,
  addMonths,
  addDays,
  normDate,
  recognize,
  recognizeExpiry
};
