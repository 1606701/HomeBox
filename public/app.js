'use strict';

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var VB = { w: 100, h: 88 };

  // 必须与 index.html 里 style.css / app.js 的 ?v= 保持一致。
  // 页面底部会把它显示出来，一眼就能确认浏览器拿到的是不是最新代码。
  var APP_VERSION = 'v14';

  // 8 个固定类目：统计维度靠它聚合，所以不做自由输入
  var CATEGORIES = ['衣物', '食品', '药品', '日化', '工具', '电子', '文具', '其他'];
  var STATES = [
    { k: 'in_use', n: '在用' },
    { k: 'used_up', n: '用完了' },
    { k: 'lent', n: '借出了' },
    { k: 'discarded', n: '已丢弃' }
  ];

  var state = {
    tab: 'search',
    prevTab: 'search',
    mapMode: 'map',
    tree: [],
    flat: [],
    items: [],
    byId: {},
    query: '',
    editingId: null,
    activeLocId: null,
    innerId: null,
    editMode: false,
    selId: null,
    settings: null,
    renamingCell: null,
    auth: {
      me: null,
      members: [],
      caps: {},
      roles: [],
      needSetup: false,
      bootstrap: false
    },
    stats: { by: 'loc', data: null, loading: false },
    // 提醒页与设置页都是懒加载：切进去才拉，省得每次开机都多两个请求
    remind: { data: null },
    notify: { settings: null, jobs: null, backup: null },
    wb: {
      loaded: false,
      stale: true,
      items: [],
      dict: null,
      facets: null,
      season: '',
      pickedSeason: '',
      filters: { type: '', season: '', color: '', status: '', owner: '' },
      editingId: null
    }
  };

  /* ---------- 工具 ---------- */

  // 页面手上的代码版本与服务端不一致时，底部弹一条「点一下刷新」。
  // 这是吃过的亏：改了前端、用户开着旧页面，怎么测都像「功能没生效」。
  function watchVersion() {
    var shown = false;
    function check() {
      if (shown) return;
      api('/api/version').then(function (d) {
        if (!d || !d.version || d.version === APP_VERSION || shown) return;
        shown = true;
        var bar = document.createElement('button');
        bar.type = 'button';
        bar.className = 'update-bar';
        bar.textContent = '有新版本（' + d.version + '），点这里刷新';
        bar.addEventListener('click', function () { location.reload(); });
        document.body.appendChild(bar);
      }).catch(function () { /* 离线时忽略 */ });
    }
    setInterval(check, 60000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') check();
    });
    check();
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, 2000);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // 能力判断全部走后端下发的 caps：前端只是不显示不该有的东西
  function can(cap) {
    return !!(state.auth.caps && state.auth.caps[cap]);
  }

  function thousands(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // 分 → ¥。null 一律是「未记价」，绝不能显示成 ¥0
  function formatMoney(cents) {
    if (cents == null || cents === '') return '未记价';
    var n = Number(cents);
    if (!isFinite(n)) return '未记价';
    var neg = n < 0;
    n = Math.abs(Math.round(n));
    var yuan = Math.floor(n / 100);
    var rest = n - yuan * 100;
    var out = '¥' + thousands(yuan);
    if (rest) out += '.' + (rest < 10 ? '0' : '') + rest;
    return (neg ? '-' : '') + out;
  }

  // 统计条位置窄，万元级折成「¥1.2万」，其余保持和其它地方一致的精确金额
  function formatMoneyCompact(cents) {
    if (cents == null || cents === '') return '—';
    var n = Number(cents);
    if (!isFinite(n)) return '—';
    var yuan = n / 100;
    if (yuan >= 10000) {
      var w = yuan / 10000;
      return '¥' + (w >= 10 ? Math.round(w) : Math.round(w * 10) / 10) + '万';
    }
    return formatMoney(cents);
  }

  function roleName(k) {
    var hit = (state.auth.roles || []).filter(function (r) { return r.k === k; })[0];
    return hit ? hit.n : (k || '');
  }

  function memberName(id) {
    if (!id) return '共用';
    var hit = (state.auth.members || []).filter(function (m) { return m.id === id; })[0];
    return hit ? hit.name : '已删除成员';
  }

  function api(url, options) {
    var opts = Object.assign({
      // 同源本来就会带 Cookie，写明是为了以后加子域时别踩坑
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, options || {});
    return fetch(url, opts)
      .then(function (res) {
        return res.json().catch(function () { throw new Error('服务端返回异常'); });
      })
      .then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.error) || '操作失败');
        return data;
      });
  }

  // 有些接口用 {ok:false, detail} 表达业务失败（比如手动跑任务、检测目录），
  // 真实原因在 detail 里。用 api() 会被盖成「操作失败」，所以这里不抛错，
  // 交给调用方自己决定怎么显示。
  function apiSoft(url, options) {
    var opts = Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, options || {});
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { throw new Error('服务端返回异常'); });
    });
  }

  /* ---------- 日期 ---------- */

  // 本机日期 YYYY-MM-DD。与后端 reminders.localDate 同口径：一律本地时间。
  // 香橙派没有 RTC，用 toISOString() 会在早上八点前差一天。
  function todayStr() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /**
   * 距今天还有几天（正数=未来，负数=已过期）。
   * 只算到「天」，两端都取当天 00:00 再相减，避开时区和夏令时的零头。
   * @param {string} dateStr YYYY-MM-DD
   * @returns {number|null}
   */
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    var a = new Date(todayStr() + 'T00:00:00').getTime();
    var b = new Date(String(dateStr).slice(0, 10) + 'T00:00:00').getTime();
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  function fmtBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ISO 时间戳 → 「2026-10-23 08:30」，设置页只看这一种精度
  function fmtTime(iso) {
    if (!iso) return '还没有';
    return String(iso).slice(0, 16).replace('T', ' ');
  }

  /**
   * 页面内错误/提示框。设置页明确要求不 alert，错误原文必须落在页面上。
   * @param {string} id 元素 id
   * @param {string} text 文案（空串 = 收起）
   * @param {boolean} isErr 是否错误
   */
  function showMsg(id, text, isErr) {
    var el = $(id);
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.className = 'errbox' + (isErr ? '' : ' is-ok');
    el.textContent = text;
  }

  function node(id) { return state.byId[id]; }

  /* ---------- 照片 ----------
     手机直出的照片动辄三四千像素、好几 MB。家里虽然传得快，
     但香橙派的 TF 卡写入慢、空间也有限，所以先在浏览器里压成
     长边 1280 的 JPEG，通常能压到原来的十分之一以下，肉眼看不出差别。 */

  var PHOTO_MAX_SIDE = 1280;
  // 识别上传用的尺寸：720 足够模型看清是什么，token 和流量都省一半
  var AI_MAX_SIDE = 720;

  function compressImage(file, maxSide) {
    var limit = maxSide || PHOTO_MAX_SIDE;
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('没读到图片')); return; }
      var looksImage = /^image\//i.test(file.type) ||
        /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '');
      if (!looksImage) { reject(new Error('选的不是图片，换一张试试')); return; }

      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('这个文件读不出来')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () {
          reject(new Error('这张图打不开，可能是 HEIC 格式，换成相册里的 JPEG 试试'));
        };
        img.onload = function () {
          try {
            var sw = img.naturalWidth || 1;
            var sh = img.naturalHeight || 1;
            var scale = Math.min(1, limit / Math.max(sw, sh));
            var w = Math.max(1, Math.round(sw * scale));
            var h = Math.max(1, Math.round(sh * scale));
            var cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            var ctx = cv.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve({ dataUrl: cv.toDataURL('image/jpeg', 0.82), w: w, h: h });
          } catch (err) {
            reject(new Error('处理这张图时失败了'));
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function photoUrl(file) {
    return file ? '/photos/' + file : '';
  }

  /* ---------- 拍照识别 ----------
     没启用时按钮不渲染（接口返回 404 / available=false），
     识别失败只 toast 一行灰字，表单永远能手动填完。 */

  var AI_PRESETS = {
    zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash' },
    qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-plus' }
  };
  var aiBusy = false;

  function refreshAiStatus() {
    return api('/api/ai/status').then(function (d) {
      var on = !!(d && d.available);
      ['f-ai-btn', 'g-ai-btn'].forEach(function (id) {
        var el = $(id);
        if (el) el.hidden = !on;
      });
    }).catch(function () {
      ['f-ai-btn', 'g-ai-btn'].forEach(function (id) {
        var el = $(id);
        if (el) el.hidden = true;
      });
    });
  }

  // 把模型给的草稿填进表单。只填空字段，不覆盖用户已经打的字。
  function applyDraft(draft, kind) {
    var isItem = kind === 'item';
    var nameEl = isItem ? $('f-name') : $('g-name');
    if (draft.name) nameEl.value = draft.name;

    if (isItem) {
      if (draft.category && $('f-category')) $('f-category').value = draft.category;
      if (draft.tags && draft.tags.length) $('f-tags').value = draft.tags.join(',');
    }
    if (draft.locationName) {
      var sel = isItem ? $('f-loc') : $('g-loc');
      for (var i = 0; i < sel.options.length; i += 1) {
        if (sel.options[i].textContent.indexOf(draft.locationName) !== -1) {
          sel.value = sel.options[i].value;
          break;
        }
      }
    }
    toast('认出来了，看看对不对再保存');
  }

  function runRecognize(file, kind, btn) {
    if (aiBusy || !file) return;
    aiBusy = true;
    var label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '正在认…';

    compressImage(file, AI_MAX_SIDE).then(function (out) {
      return api('/api/vision/recognize', {
        method: 'POST', body: JSON.stringify({ image: out.dataUrl })
      });
    }).then(function (d) {
      if (d && d.ok && d.draft) {
        applyDraft(d.draft, kind);
      } else {
        // 失败一律「一行灰字」，不弹窗、不阻断
        toast((d && d.hint) || '没认出来，先手动填吧');
      }
    }).catch(function (err) {
      toast(err.message || '识别不可用，先手动填吧');
    }).then(function () {
      aiBusy = false;
      btn.disabled = false;
      btn.innerHTML = label;
    });
  }

  ['f', 'g'].forEach(function (prefix) {
    var btn = $(prefix + '-ai-btn');
    var input = $(prefix + '-ai-file');
    if (!btn || !input) return;
    var kind = prefix === 'f' ? 'item' : 'garment';
    btn.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';   // 允许连着选同一张
      if (!file) return;
      // 这张照片不只是给模型看的：按存档尺寸压一张挂到照片区，
      // 识别失败也不浪费，保存时直接跟着上传。
      var picker = kind === 'item' ? itemPhotos : garmentPhotos;
      compressImage(file, PHOTO_MAX_SIDE).then(function (out) {
        if (picker) picker.setPending(out.dataUrl);
      }).catch(function () { /* 压缩失败不挡识别 */ });
      runRecognize(file, kind, btn);
    });
  });

  function uploadPhoto(id, dataUrl) {
    var base64 = dataUrl.indexOf('base64,') !== -1 ? dataUrl.split('base64,')[1] : dataUrl;
    return api('/api/items/' + encodeURIComponent(id) + '/photo', {
      method: 'POST', body: JSON.stringify({ data: base64 })
    });
  }

  function dropPhoto(id) {
    return api('/api/items/' + encodeURIComponent(id) + '/photo', { method: 'DELETE' });
  }

  // 两个表单的照片区长得一模一样，用同一套逻辑驱动，免得两边行为跑偏
  function makePhotoPicker(prefix) {
    var p = {
      prefix: prefix,
      pending: null,   // 刚选好、还没上传的压缩图
      existing: null,  // 服务器上已有的照片
      cleared: false   // 用户主动把原来的照片删了
    };

    function paint() {
      var box = $(prefix + '-photo-preview');
      var src = p.pending || (p.existing ? photoUrl(p.existing) : '');
      box.hidden = !src;
      if (src) $(prefix + '-photo-img').src = src;
    }

    function pick(how) {
      var input = $(prefix + '-photo-file');
      // capture=environment 会直接叫出后置摄像头；不带这个属性就是打开相册
      if (how === 'camera') input.setAttribute('capture', 'environment');
      else input.removeAttribute('capture');
      input.click();
    }

    $(prefix + '-photo-take').addEventListener('click', function () { pick('camera'); });
    $(prefix + '-photo-pick').addEventListener('click', function () { pick('album'); });

    $(prefix + '-photo-file').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = ''; // 清空后才能连着再选同一个文件
      if (!file) return;
      toast('正在处理照片…');
      compressImage(file).then(function (out) {
        p.pending = out.dataUrl;
        p.cleared = false;
        paint();
        toast('照片已选好，保存时会一起上传');
      }).catch(function (err) { toast(err.message); });
    });

    $(prefix + '-photo-del').addEventListener('click', function () {
      p.pending = null;
      p.existing = null;
      p.cleared = true;
      paint();
    });

    // 识别/其他入口塞一张进来（dataUrl），当作用户自己选的照片
    p.setPending = function (dataUrl) {
      if (!dataUrl) return;
      p.pending = dataUrl;
      p.cleared = false;
      paint();
    };

    p.reset = function (existingFile) {
      p.pending = null;
      p.existing = existingFile || null;
      p.cleared = false;
      paint();
      return p;
    };

    // 提交后调：返回 null 表示照片这块没变化，否则返回一个要等待的请求
    p.commit = function (id) {
      if (p.pending) {
        var url = p.pending;
        p.pending = null;
        return { type: 'upload', req: uploadPhoto(id, url) };
      }
      if (p.cleared) {
        p.cleared = false;
        return { type: 'drop', req: dropPhoto(id) };
      }
      return null;
    };

    paint();
    return p;
  }

  /* ---------- 查看大图 ---------- */

  function openLightbox(src, alt) {
    $('lb-img').src = src;
    $('lb-img').alt = alt || '物品照片';
    $('lightbox').hidden = false;
  }

  function closeLightbox() {
    $('lightbox').hidden = true;
    $('lb-img').removeAttribute('src');
  }

  $('lightbox').addEventListener('click', function (e) {
    if (e.target === this || e.target.id === 'lb-close') closeLightbox();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('lightbox').hidden) closeLightbox();
  });

  var itemPhotos = makePhotoPicker('f');
  var garmentPhotos = makePhotoPicker('g');

  function pathOf(id) {
    var p = [];
    var cur = node(id);
    var guard = 0;
    while (cur && guard < 32) {
      p.unshift(cur.name);
      cur = cur.parent ? node(cur.parent) : null;
      guard += 1;
    }
    return p.length ? p.join(' › ') : '未归档';
  }

  /* ---------- 标签页 ---------- */

  function setTab(tab) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('is-active', b.dataset.tab === tab);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) {
      v.classList.toggle('is-active', v.id === 'view-' + tab);
    });
    // 衣柜数据是懒加载的，切进来时才发现数据是旧的就补一次
    if (tab === 'wardrobe' && (state.wb.stale || !state.wb.loaded)) loadWardrobe();
    // 提醒同理：进来就重新拉一次，红点始终是「现在」的数字
    if (tab === 'reminders') {
      loadReminders().catch(function (err) { toast(err.message); });
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (btn) {
    btn.addEventListener('click', function () { setTab(btn.dataset.tab); });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.seg'), function (btn) {
    btn.addEventListener('click', function () {
      // 季节切换按钮属于衣柜模块，不带 data-mode
      if (!btn.dataset.mode) return;
      state.mapMode = btn.dataset.mode;
      Array.prototype.forEach.call(document.querySelectorAll('.seg'), function (b) {
        b.classList.toggle('is-active', b.dataset.mode === state.mapMode);
      });
      $('pane-map').hidden = state.mapMode !== 'map';
      $('pane-list').hidden = state.mapMode !== 'list';
    });
  });

  /* ---------- 物品卡片 ---------- */

  // 有照片时左边放一张缩略图，没有就整宽显示，不留空白列
  function thumbHtml(item) {
    if (!item.photo) return '';
    var src = photoUrl(item.photo);
    return '<img class="rthumb" src="' + esc(src) + '" loading="lazy"' +
      ' alt="' + esc(item.name) + '" data-full="' + esc(src) + '" />';
  }

  function cardHtml(item) {
    var tags = (item.tags || []).map(function (t) {
      return '<span class="tag">' + esc(t) + '</span>';
    }).join('');
    var acts = '';
    if (can('write')) {
      acts += '<button type="button" class="mini" data-act="edit" data-id="' + esc(item.id) + '">编辑</button>';
    }
    if (can('remove')) {
      acts += '<button type="button" class="mini danger" data-act="del" data-id="' + esc(item.id) + '">删除</button>';
    }
    return '' +
      '<article class="result' + (item.photo ? ' ph' : '') + '">' +
        thumbHtml(item) +
        '<div class="result-main">' +
          '<div class="result-top">' +
            '<h3 class="result-name">' + esc(item.name) + '</h3>' +
            '<span class="result-qty">×' + esc(item.qty || 1) + '</span>' +
          '</div>' +
          '<div class="result-path">' + esc(item.path) + '</div>' +
          (item.note ? '<div class="result-note">' + esc(item.note) + '</div>' : '') +
          (tags ? '<div class="result-tags">' + tags + '</div>' : '') +
          (acts ? '<div class="result-actions">' + acts + '</div>' : '') +
          itemBadges(item) +
        '</div>' +
      '</article>';
  }

  // 右下角小角标：过期/临期与低库存（本地算，不额外请求）、金额、类目、归属人
  function itemBadges(item) {
    var out = '';
    stockBadges(item).forEach(function (b) {
      out += '<span class="badge badge-' + b.k + '">' + esc(b.t) + '</span>';
    });
    if (can('seePrice')) {
      // 服务端对无权限角色是「删 key」而不是置 0，必须判断 key 是否存在
      if ('valueCents' in item && item.valueCents != null) {
        out += '<span class="badge badge-money">' + esc(formatMoney(item.valueCents)) + '</span>';
      } else {
        out += '<span class="badge badge-muted">未记价</span>';
      }
    }
    if (item.category) out += '<span class="badge">' + esc(item.category) + '</span>';
    out += '<span class="badge">' + esc(memberName(item.ownerId)) + '</span>';
    return '<div class="result-badges">' + out + '</div>';
  }

  /**
   * 过期 / 低库存角标文案。搜索卡片和衣柜卡片共用一套判断，免得两处口径跑偏。
   * @param {object} item 物品
   * @returns {{t:string,k:string}[]} k = danger|warn
   */
  function stockBadges(item) {
    var out = [];
    var left = daysUntil(item.expireAt);
    if (item.expireAt && left != null) {
      if (left < 0) out.push({ t: '已过期', k: 'danger' });
      else if (left <= 3) {
        out.push({ t: left === 0 ? '今天到期' : left + ' 天后到期', k: 'warn' });
      }
    }
    if (item.minQty != null && Number(item.qty) < Number(item.minQty)) {
      out.push({ t: '快没了', k: 'warn' });
    }
    return out;
  }

  function renderItems(box, items, emptyHtml) {
    if (!items.length) {
      box.innerHTML = '<p class="empty">' + emptyHtml + '</p>';
      return;
    }
    box.innerHTML = '<div class="results">' + items.map(cardHtml).join('') + '</div>';
  }

  /* ---------- 统计 ---------- */

  function renderStats() {
    var loose = state.items.filter(function (i) { return !i.locId; }).length;
    $('stat-items').textContent = state.items.length;
    $('stat-locs').textContent = state.flat.length;
    $('stat-loose').textContent = loose;

    var wrap = $('stat-value-wrap');
    var val = $('stat-value');
    var bar = $('stats-bar');
    if (wrap) wrap.hidden = !can('seePrice');
    if (val) {
      var totals = state.stats.data && state.stats.data.totals;
      val.textContent = totals ? formatMoneyCompact(totals.inUseCents) : '—';
    }
    if (bar) {
      bar.classList.toggle('four', can('seePrice'));
      bar.classList.toggle('is-entry', can('stats'));
      bar.setAttribute('tabindex', can('stats') ? '0' : '-1');
    }
  }

  /* ---------- 价值概览 ---------- */

  function loadStats(by) {
    if (!can('stats')) return Promise.resolve(null);
    var dim = by || state.stats.by || 'loc';
    state.stats.loading = true;
    return api('/api/stats/value?by=' + encodeURIComponent(dim)).then(function (data) {
      state.stats.loading = false;
      state.stats.data = data;
      state.stats.by = data.by || dim;
      renderStats();
      if (state.tab === 'stats') renderStatsView();
      return data;
    }).catch(function (err) {
      state.stats.loading = false;
      toast('统计没算出来：' + err.message);
      return null;
    });
  }

  function showStats() {
    if (!can('stats')) return;
    if (state.tab !== 'stats') state.prevTab = state.tab;
    setTab('stats');
    loadStats(state.stats.by);
    renderStatsView();
    window.scrollTo(0, 0);
  }

  function renderStatsView() {
    var seg = $('stats-seg');
    if (seg) {
      Array.prototype.forEach.call(seg.querySelectorAll('.seg'), function (b) {
        b.classList.toggle('is-active', b.dataset.by === state.stats.by);
      });
    }
    var data = state.stats.data;
    if (!data || !data.totals) {
      $('sv-cover').textContent = state.stats.loading ? '正在算…' : '还没有可以统计的金额';
      $('sv-groups').innerHTML = '<p class="hint">正在统计…</p>';
      return;
    }
    var t = data.totals;
    $('sv-inuse').textContent = formatMoney(t.inUseCents);
    $('sv-all').textContent = formatMoney(t.allCents);
    $('sv-cover').textContent = t.count + ' 件里有 ' + t.recorded + ' 件记了价，' +
      t.unrecorded + ' 件未记录';

    var groups = (data.groups || []).slice();
    if (!groups.length) {
      $('sv-groups').innerHTML = '<p class="hint">还没有可以统计的东西</p>';
      return;
    }
    var max = 0;
    groups.forEach(function (g) { if (g.valueCents > max) max = g.valueCents; });
    $('sv-groups').innerHTML = groups.map(function (g) {
      var pct = g.valueCents > 0 ? Math.max(3, Math.round(g.valueCents / (max || 1) * 100)) : 0;
      return '<div class="bar-row">' +
        '<span class="bar-k" title="' + esc(g.name) + '">' + esc(g.name) +
          '<span class="cn">' + (g.count || 0) + ' 件</span></span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="bar-v">' + esc(formatMoney(g.valueCents)) + '</span>' +
      '</div>';
    }).join('');
  }

  $('stats-bar').addEventListener('click', showStats);
  $('stats-bar').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      showStats();
    }
  });

  $('stats-back').addEventListener('click', function () {
    setTab(state.prevTab === 'stats' ? 'search' : (state.prevTab || 'search'));
  });

  $('stats-seg').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.seg') : null;
    if (!btn || !btn.dataset.by) return;
    state.stats.by = btn.dataset.by;
    Array.prototype.forEach.call(this.querySelectorAll('.seg'), function (b) {
      b.classList.toggle('is-active', b.dataset.by === state.stats.by);
    });
    loadStats(state.stats.by);
  });

  function barList(pairs, maxItems) {
    if (!pairs.length) return '';
    var arr = pairs.slice().sort(function (a, b) { return b.v - a.v; }).slice(0, maxItems || 8);
    var max = arr[0].v || 1;
    return arr.map(function (x) {
      var pct = Math.max(4, Math.round(x.v / max * 100));
      return '' +
        '<div class="bar-row">' +
          '<span class="bar-k" title="' + esc(x.k) + '">' + esc(x.k) + '</span>' +
          '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
          '<span class="bar-v">' + x.v + '</span>' +
        '</div>';
    }).join('');
  }

  function renderCharts() {
    var tagMap = {};
    state.items.forEach(function (i) {
      var key = (i.tags && i.tags.length) ? i.tags[0] : '未分类';
      tagMap[key] = (tagMap[key] || 0) + 1;
    });
    var tagPairs = Object.keys(tagMap).map(function (k) { return { k: k, v: tagMap[k] }; });
    $('chart-tags').innerHTML = barList(tagPairs, 8) ||
      '<p class="hint">给物品加上标签，这里就会显示分布</p>';

    var rooms = state.flat.filter(function (n) { return n.kind === 'room'; });
    var roomPairs = rooms.map(function (r) {
      return { k: r.name, v: r.totalCount || 0 };
    }).filter(function (x) { return x.v > 0; });
    if (roomPairs.length) roomPairs.push({
      k: '没归位', v: state.items.filter(function (i) { return !i.locId; }).length
    });
    $('chart-rooms').innerHTML = barList(roomPairs, 8) ||
      '<p class="hint">把东西放到具体位置后就能看到分布</p>';
  }

  /* ---------- 加载与搜索 ---------- */

  function loadItems(keyword) {
    var url = keyword ? '/api/items?q=' + encodeURIComponent(keyword) : '/api/items';
    return api(url).then(function (data) {
      state.items = data.items;
      return data.items;
    });
  }

  function doSearch() {
    return loadItems(state.query).then(function (items) {
      var emptyHtml = state.query
        ? '没找到「' + esc(state.query) + '」，要不要先记一件？'
        : '还没记录任何东西，去「记一件」开始吧';
      renderItems($('results'), items, emptyHtml);
      renderStats();
      renderCharts();
    }).catch(function (err) {
      renderItems($('results'), [], '加载失败：' + esc(err.message));
    });
  }

  var searchTimer = null;
  $('search').addEventListener('input', function (e) {
    setTab('search');
    clearTimeout(searchTimer);
    var val = e.target.value.trim();
    searchTimer = setTimeout(function () {
      state.query = val;
      doSearch();
    }, 160);
  });

  /* ---------- 位置树 ---------- */

  function flatten(nodes, out, prefix, depth) {
    nodes.forEach(function (n) {
      var label = prefix ? prefix + ' / ' + n.name : n.name;
      out.push({
        id: n.id, name: n.name, label: label, depth: depth, parent: n.parent,
        kind: n.kind, box: n.box, itemCount: n.itemCount, totalCount: n.totalCount,
        // 无权限角色拿不到这个 key，后面用 > 0 判断即可
        valueCents: n.valueCents
      });
      if (n.children && n.children.length) flatten(n.children, out, label, depth + 1);
    });
    return out;
  }

  function buildNode(nodeRow, isRoot) {
    var wrap = document.createElement('div');
    wrap.className = 'tree-node' + (isRoot ? ' tree-node-root' : '');

    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'tree-head' + (state.activeLocId === nodeRow.id ? ' is-active' : '');

    var nameSpan = document.createElement('span');
    nameSpan.textContent = nodeRow.name;
    var countSpan = document.createElement('span');
    countSpan.textContent = (nodeRow.totalCount || 0) + ' 件';
    head.appendChild(nameSpan);
    head.appendChild(countSpan);
    head.addEventListener('click', function () {
      selectLocation(nodeRow.id, nodeRow.name, $('loc-items'));
    });
    wrap.appendChild(head);

    if (nodeRow.children && nodeRow.children.length) {
      var kids = document.createElement('div');
      kids.className = 'tree-children';
      nodeRow.children.forEach(function (c) { kids.appendChild(buildNode(c, false)); });
      wrap.appendChild(kids);
    }
    return wrap;
  }

  function renderTree() {
    var box = $('tree-list');
    box.innerHTML = '';
    if (!state.tree.length) {
      box.innerHTML = '<p class="empty">还没有收纳位置，去「记一件」里新建一个</p>';
      return;
    }
    state.tree.forEach(function (root) { box.appendChild(buildNode(root, true)); });
  }

  function renderLocSelects() {
    var opts = '<option value="">— 未归档 —</option>' + state.flat.map(function (o) {
      return '<option value="' + esc(o.id) + '">' + esc(o.label) + '</option>';
    }).join('');
    var keep = $('f-loc').value;
    $('f-loc').innerHTML = opts;
    if (keep) $('f-loc').value = keep;

    var parentOpts = '<option value="">（顶层，自成一家）</option>' + state.flat.map(function (o) {
      return '<option value="' + esc(o.id) + '">' + esc(o.label) + '</option>';
    }).join('');
    var keepParent = $('f-newloc-parent').value;
    $('f-newloc-parent').innerHTML = parentOpts;
    if (keepParent) $('f-newloc-parent').value = keepParent;

    // 衣柜的衣物表单也用同一份位置列表
    if ($('g-loc')) {
      var keepGloc = $('g-loc').value;
      $('g-loc').innerHTML = opts;
      if (keepGloc) $('g-loc').value = keepGloc;
    }
  }

  function loadLocations() {
    return api('/api/locations').then(function (data) {
      state.tree = data.tree;
      state.settings = data.settings || { planWidthM: 12 };
      state.flat = flatten(data.tree, [], '', 0);
      state.byId = {};
      state.flat.forEach(function (n) { state.byId[n.id] = n; });
      renderTree();
      renderLocSelects();
      paintPlan();
    });
  }

  function collectSubtree(id) {
    var out = [id];
    state.flat.forEach(function (n) {
      if (n.parent === id) out = out.concat(collectSubtree(n.id));
    });
    return out;
  }

  function selectLocation(id, name, target) {
    state.activeLocId = id;
    renderTree();
    paintPlan();
    var cur = node(id);
    var money = (can('seePrice') && cur && cur.valueCents > 0)
      ? '<p class="loc-value">已记价 ' + esc(formatMoney(cur.valueCents)) + '</p>'
      : '';
    return loadItems('').then(function (all) {
      var box = target || $('loc-items');
      var ids = collectSubtree(id);
      var list = all.filter(function (i) { return ids.indexOf(i.locId) !== -1; });
      // 标题和金额必须先拼进来：renderItems 会整块替换 innerHTML
      var head = '<p class="loc-title">' + esc(name) +
        (list.length ? ' · ' + list.length + ' 件' : '') + '</p>' + money;
      if (!list.length) {
        box.innerHTML = head + '<p class="empty">这里还是空的</p>';
        return;
      }
      box.innerHTML = head + '<div class="results">' + list.map(cardHtml).join('') + '</div>';
    });
  }

  /* ---------- 家的地图（俯视图） ---------- */

  var ROOM_FILLS = ['#f7f1e4', '#eaeff6', '#eef4ec', '#f7ecf0', '#f2efe6', '#eaf2f2'];
  var HEATS = ['#e3dac9', '#f0cba6', '#e7a862', '#c4662c'];

  function heat(n) {
    if (!n) return HEATS[0];
    if (n <= 2) return HEATS[1];
    if (n <= 5) return HEATS[2];
    return HEATS[3];
  }

  // 没有坐标时按网格兜底排布，保证老数据或新位置也能出现在图上
  function ensureBoxes() {
    var rooms = state.flat.filter(function (n) { return n.kind === 'room'; });
    rooms.forEach(function (r, i) {
      if (r.box) return;
      var perRow = 3, rw = 30, rh = 24, gap = 2;
      r.box = {
        x: 3 + (i % perRow) * (rw + gap),
        y: 3 + Math.floor(i / perRow) * (rh + gap),
        w: rw, h: rh
      };
    });
    var furns = state.flat.filter(function (n) { return n.kind === 'furniture'; });
    furns.forEach(function (f) {
      if (f.box) return;
      var parent = f.parent ? node(f.parent) : null;
      if (!parent || !parent.box) return;
      var bucket = state._auto = state._auto || {};
      var key = parent.id;
      bucket[key] = (bucket[key] || 0);
      var idx = bucket[key];
      bucket[key] = idx + 1;
      var fw = 13, fh = 9, g2 = 1.5;
      f.box = {
        x: parent.box.x + 2 + (idx % 2) * (fw + g2),
        y: parent.box.y + 5 + Math.floor(idx / 2) * (fh + g2),
        w: fw, h: fh
      };
      f.box.x = Math.min(f.box.x, parent.box.x + parent.box.w - fw - 1);
    });
  }

  // 把抽象坐标换算成真实面积，让用户知道自己画的房间多大
  function areaText(n) {
    if (!n.box || !state.settings || !state.settings.planWidthM) return '';
    var s = state.settings.planWidthM / VB.w;
    var a = n.box.w * s * n.box.h * s;
    return (a >= 10 ? a.toFixed(0) : a.toFixed(1)) + ' ㎡';
  }

  function handleSvg(n) {
    if (!state.editMode || state.selId !== n.id || !n.box) return '';
    return '<rect class="hnd" data-hnd="1" x="' + (n.box.x + n.box.w - 3) +
      '" y="' + (n.box.y + n.box.h - 3) + '" width="3" height="3" rx="0.7" ' +
      'fill="#b4531f" stroke="#fff" stroke-width="0.35"/>';
  }

  function paintPlan() {
    var svg = $('floorplan');
    if (!svg) return;
    ensureBoxes();

    var rooms = state.flat.filter(function (n) { return n.kind === 'room' && n.box; });
    var furns = state.flat.filter(function (n) { return n.kind === 'furniture' && n.box; });

    var p = [];
    p.push('<rect x="0" y="0" width="' + VB.w + '" height="' + VB.h + '" rx="1.5" fill="#f2ede2"/>');

    // 编辑模式下画网格，方便把房间对齐
    if (state.editMode) {
      var gx, gy;
      for (gx = 10; gx < VB.w; gx += 10) {
        p.push('<line x1="' + gx + '" y1="0" x2="' + gx + '" y2="' + VB.h +
          '" stroke="#e9e1d1" stroke-width="0.15"/>');
      }
      for (gy = 10; gy < VB.h; gy += 10) {
        p.push('<line x1="0" y1="' + gy + '" x2="' + VB.w + '" y2="' + gy +
          '" stroke="#e9e1d1" stroke-width="0.15"/>');
      }
    }

    rooms.forEach(function (r, ri) {
      var b = r.box;
      var active = state.activeLocId === r.id;
      var sel = state.editMode && state.selId === r.id;
      var area = areaText(r);
      p.push('<g data-id="' + esc(r.id) + '" data-kind="room" class="rm' +
        (state.editMode ? ' editable' : '') + '">');
      p.push('<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h +
        '" rx="1.6" fill="' + ROOM_FILLS[ri % ROOM_FILLS.length] +
        '" stroke="' + (sel ? '#b4531f' : (active ? '#b4531f' : '#ddd4c3')) +
        '" stroke-width="' + (sel ? 1 : (active ? 0.7 : 0.3)) + '"/>');
      p.push('<text class="rmname" x="' + (b.x + 2) + '" y="' + (b.y + 4.6) + '">' + esc(r.name) + '</text>');
      p.push('<text class="rmcount" x="' + (b.x + b.w - 2) + '" y="' + (b.y + 4.6) +
        '" text-anchor="end">' + (r.totalCount || 0) + ' 件</text>');
      if (area) {
        p.push('<text class="rmarea" x="' + (b.x + 2) + '" y="' + (b.y + 8.6) + '">' + esc(area) + '</text>');
      }
      p.push(handleSvg(r));
      p.push('</g>');
    });

    furns.forEach(function (f) {
      var b = f.box;
      var active = state.activeLocId === f.id;
      var sel = state.editMode && state.selId === f.id;
      p.push('<g data-id="' + esc(f.id) + '" data-kind="furniture" class="fn' +
        (state.editMode ? ' editable' : '') + '">');
      p.push('<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h +
        '" rx="1.2" fill="' + heat(f.totalCount) +
        '" stroke="' + (sel ? '#b4531f' : (active ? '#7c3512' : 'rgba(0,0,0,0.14)')) +
        '" stroke-width="' + (sel ? 0.9 : (active ? 0.8 : 0.3)) + '"/>');
      p.push('<text class="fnname" x="' + (b.x + b.w / 2) + '" y="' + (b.y + b.h / 2 + 0.2) +
        '" text-anchor="middle">' + esc(f.name) + '</text>');
      if (f.totalCount) {
        p.push('<text class="fncount" x="' + (b.x + b.w / 2) + '" y="' + (b.y + b.h - 1.3) +
          '" text-anchor="middle">' + f.totalCount + '</text>');
      }
      p.push(handleSvg(f));
      p.push('</g>');
    });

    svg.innerHTML = p.join('');
  }

  function toVB(evt) {
    var rect = $('floorplan').getBoundingClientRect();
    return {
      x: (evt.clientX - rect.left) / rect.width * VB.w,
      y: (evt.clientY - rect.top) / rect.height * VB.h
    };
  }

  var drag = null;
  var dragMoved = false;

  $('floorplan').addEventListener('pointerdown', function (e) {
    if (!state.editMode) return;
    var hnd = e.target.closest ? e.target.closest('[data-hnd]') : null;
    var g = e.target.closest ? e.target.closest('g[data-id]') : null;
    if (!g) return;
    var n = node(g.dataset.id);
    if (!n || !n.box || n.kind === 'home') return;
    var pt = toVB(e);
    if (hnd) {
      drag = { n: n, mode: 'resize', sw: n.box.w, sh: n.box.h, sx: pt.x, sy: pt.y };
    } else {
      drag = { n: n, mode: 'move', offX: pt.x - n.box.x, offY: pt.y - n.box.y };
    }
    dragMoved = false;
    selectPlanNode(n.id);
    try { $('floorplan').setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    e.preventDefault();
  });

  $('floorplan').addEventListener('pointermove', function (e) {
    if (!drag) return;
    var pt = toVB(e);
    var b = drag.n.box;
    if (drag.mode === 'resize') {
      var minW = drag.n.kind === 'room' ? 8 : 4;
      var minH = drag.n.kind === 'room' ? 7 : 3.5;
      b.w = clamp(drag.sw + (pt.x - drag.sx), minW, VB.w - b.x);
      b.h = clamp(drag.sh + (pt.y - drag.sy), minH, VB.h - b.y);
    } else {
      b.x = clamp(pt.x - drag.offX, 0, VB.w - b.w);
      b.y = clamp(pt.y - drag.offY, 0, VB.h - b.h);
    }
    dragMoved = true;
    updateNodeDom(drag.n);
  });

  // 家具落到哪个房间里，就归到哪个房间名下
  function roomAt(b) {
    var cx = b.x + b.w / 2;
    var cy = b.y + b.h / 2;
    var rooms = state.flat.filter(function (n) { return n.kind === 'room' && n.box; });
    for (var i = 0; i < rooms.length; i += 1) {
      var r = rooms[i].box;
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return rooms[i];
    }
    return null;
  }

  function endDrag() {
    if (!drag) return;
    var n = drag.n;
    drag = null;
    if (!dragMoved) return;
    var payload = { box: n.box };
    var movedTo = null;
    if (n.kind === 'furniture') {
      var host = roomAt(n.box);
      if (host && host.id !== n.parent) {
        payload.parent = host.id;
        movedTo = host.name;
      }
    }
    api('/api/locations/' + encodeURIComponent(n.id), {
      method: 'PUT', body: JSON.stringify(payload)
    }).then(function () {
      toast(movedTo ? '挪到「' + movedTo + '」了' : '摆放已记住');
      return loadLocations();
    }).then(function () {
      if (state.selId) selectPlanNode(state.selId);
    }).catch(function (err) { toast(err.message); });
  }

  $('floorplan').addEventListener('pointerup', endDrag);
  $('floorplan').addEventListener('pointercancel', endDrag);

  // 拖动时只改 DOM，不重绘整张图，手感才跟得上
  function updateNodeDom(n) {
    var g = $('floorplan').querySelector('g[data-id="' + n.id + '"]');
    if (!g) return;
    var b = n.box;
    var rect = g.querySelector('rect');
    rect.setAttribute('x', b.x);
    rect.setAttribute('y', b.y);
    rect.setAttribute('width', b.w);
    rect.setAttribute('height', b.h);
    if (n.kind === 'room') {
      var nm = g.querySelector('.rmname');
      if (nm) { nm.setAttribute('x', b.x + 2); nm.setAttribute('y', b.y + 4.6); }
      var ct = g.querySelector('.rmcount');
      if (ct) { ct.setAttribute('x', b.x + b.w - 2); ct.setAttribute('y', b.y + 4.6); }
      var ar = g.querySelector('.rmarea');
      if (ar) { ar.setAttribute('x', b.x + 2); ar.setAttribute('y', b.y + 8.6); }
    } else {
      var fn = g.querySelector('.fnname');
      if (fn) { fn.setAttribute('x', b.x + b.w / 2); fn.setAttribute('y', b.y + b.h / 2 + 0.2); }
      var fc = g.querySelector('.fncount');
      if (fc) { fc.setAttribute('x', b.x + b.w / 2); fc.setAttribute('y', b.y + b.h - 1.3); }
    }
    var hnd = g.querySelector('[data-hnd]');
    if (hnd) {
      hnd.setAttribute('x', b.x + b.w - 3);
      hnd.setAttribute('y', b.y + b.h - 3);
    }
  }

  $('floorplan').addEventListener('click', function (e) {
    if (dragMoved) { dragMoved = false; return; }
    if (state.editMode) return; // 编辑模式下点击只用于选中，已在 pointerdown 处理
    var g = e.target.closest ? e.target.closest('g[data-id]') : null;
    if (!g) return;
    var n = node(g.dataset.id);
    if (!n) return;
    if (n.kind === 'furniture') openInner(n.id);
    else selectLocation(n.id, n.name, $('map-detail'));
  });

  /* ---------- 户型编辑器 ---------- */

  function kindName(k) {
    return { home: '家', room: '房间', furniture: '家具', compartment: '格口' }[k] || '位置';
  }

  function homeId() {
    var root = state.flat.filter(function (n) { return !n.parent; })[0];
    return root ? root.id : null;
  }

  // 前端版防环：id 是否是 ancestorId 的后代
  function isSubOf(ancestorId, id) {
    var cur = node(id);
    var guard = 0;
    while (cur && guard < 64) {
      if (cur.parent === ancestorId) return true;
      cur = cur.parent ? node(cur.parent) : null;
      guard += 1;
    }
    return false;
  }

  function hideEditor() {
    state.selId = null;
    $('plan-editor').hidden = true;
    paintPlan();
  }

  function selectPlanNode(id) {
    var n = node(id);
    if (!n) { hideEditor(); return; }
    state.selId = id;
    $('plan-editor').hidden = false;
    $('ed-title').textContent = kindName(n.kind) + '：' + n.name;
    $('ed-name').value = n.name;
    $('ed-w').value = n.box ? Math.round(n.box.w) : '';
    $('ed-h').value = n.box ? Math.round(n.box.h) : '';

    var showParent = n.kind !== 'home';
    $('ed-parent-row').hidden = !showParent;
    if (showParent) {
      $('ed-parent').innerHTML = '<option value="">（顶层）</option>' +
        state.flat.filter(function (o) {
          return o.id !== n.id && !isSubOf(n.id, o.id);
        }).map(function (o) {
          return '<option value="' + esc(o.id) + '">' + esc(o.label) + '</option>';
        }).join('');
      $('ed-parent').value = n.parent || '';
    }

    var bits = ['合计 ' + (n.totalCount || 0) + ' 件东西'];
    var area = areaText(n);
    if (area) bits.push('约 ' + area);
    if (can('seePrice') && n.valueCents > 0) bits.push('已记价 ' + formatMoney(n.valueCents));
    if (n.kind === 'room') {
      var furn = state.flat.filter(function (x) {
        return x.parent === n.id && x.kind === 'furniture';
      }).length;
      bits.push('内有 ' + furn + ' 件家具');
    }
    $('ed-meta').textContent = bits.join(' · ');
    paintPlan();
  }

  $('ed-save').addEventListener('click', function () {
    var n = node(state.selId);
    if (!n) return;
    var name = $('ed-name').value.trim();
    if (!name) { toast('名字不能为空'); return; }
    var payload = { name: name };
    var w = Number($('ed-w').value);
    var h = Number($('ed-h').value);
    if (n.box && isFinite(w) && isFinite(h) && w > 0 && h > 0) {
      payload.box = { x: n.box.x, y: n.box.y, w: w, h: h };
    }
    if (n.kind !== 'home') payload.parent = $('ed-parent').value || null;

    api('/api/locations/' + encodeURIComponent(n.id), {
      method: 'PUT', body: JSON.stringify(payload)
    }).then(function () {
      toast('已保存');
      hideEditor();
      return Promise.all([loadLocations(), doSearch()]);
    }).catch(function (err) { toast(err.message); });
  });

  $('ed-cancel').addEventListener('click', function () { hideEditor(); });

  $('ed-del').addEventListener('click', function () {
    var n = node(state.selId);
    if (!n) return;
    var extra = '';
    if (n.kind === 'room') extra = '，房间里的家具也会一起删掉';
    if (!window.confirm('删除「' + n.name + '」吗？' + extra +
        '\n（里面的东西不会删，会变成未归档）')) return;
    api('/api/locations/' + encodeURIComponent(n.id), { method: 'DELETE' }).then(function () {
      toast('已删除：' + n.name);
      hideEditor();
      return Promise.all([loadLocations(), doSearch()]);
    }).catch(function (err) { toast(err.message); });
  });

  $('add-room').addEventListener('click', function () {
    api('/api/locations', {
      method: 'POST',
      body: JSON.stringify({ name: '新房间', kind: 'room', parent: homeId() })
    }).then(function (data) {
      toast('房间已加上，在下面改成你要的名字');
      return loadLocations().then(function () { selectPlanNode(data.location.id); });
    }).catch(function (err) { toast(err.message); });
  });

  $('add-furniture').addEventListener('click', function () {
    var sel = node(state.selId);
    var roomId = null;
    if (sel && sel.kind === 'room') roomId = sel.id;
    else if (sel && sel.kind === 'furniture' && sel.parent) roomId = sel.parent;
    if (!roomId) {
      var first = state.flat.filter(function (n) { return n.kind === 'room'; })[0];
      roomId = first ? first.id : homeId();
    }
    if (!roomId) { toast('先加一个房间吧'); return; }
    api('/api/locations', {
      method: 'POST',
      body: JSON.stringify({ name: '新家具', kind: 'furniture', parent: roomId })
    }).then(function (data) {
      toast('家具已加上，改个名字吧');
      return loadLocations().then(function () { selectPlanNode(data.location.id); });
    }).catch(function (err) { toast(err.message); });
  });

  $('plan-scale').addEventListener('click', function () {
    var row = $('scale-row');
    row.hidden = !row.hidden;
    if (!row.hidden) {
      $('scale-m').value = (state.settings && state.settings.planWidthM) || 12;
    }
  });

  $('scale-save').addEventListener('click', function () {
    var m = Number($('scale-m').value);
    api('/api/settings', { method: 'PUT', body: JSON.stringify({ planWidthM: m }) })
      .then(function (data) {
        state.settings = data.settings;
        $('scale-row').hidden = true;
        toast('已按 ' + m + ' 米宽换算面积');
        paintPlan();
      })
      .catch(function (err) { toast(err.message); });
  });

  $('toggle-edit').addEventListener('click', function () {
    state.editMode = !state.editMode;
    this.classList.toggle('is-on', state.editMode);
    this.textContent = state.editMode ? '完成编辑' : '编辑户型';
    $('plan-tools').hidden = !state.editMode;
    if (!state.editMode) {
      $('scale-row').hidden = true;
      hideEditor();
    }
    $('plan-tip').textContent = state.editMode
      ? '拖动可移动位置，拖右下角的方块可改大小；选中后在下面改名、改归属或删除'
      : '点柜子、抽屉这些家具，看里面每一格放了什么';
    paintPlan();
  });

  /* ---------- 家具内部视图 ---------- */

  function openInner(id) {
    var n = node(id);
    if (!n) return;
    state.innerId = id;
    state.activeLocId = id;
    $('inner-title').textContent = n.name;
    $('inner-path').textContent = pathOf(id);
    $('map-home').hidden = true;
    $('map-inner').hidden = false;
    paintCells();
    return selectLocation(id, n.name, $('inner-detail'));
  }

  function paintCells() {
    var cells = state.flat.filter(function (c) { return c.parent === state.innerId; });
    if (!cells.length) {
      $('cells').innerHTML = '<p class="hint">这个家具还没分格，在下面给它加几个格子</p>';
      return;
    }
    $('cells').innerHTML = cells.map(function (c) {
      var n = c.totalCount || 0;
      return '<button type="button" class="cell' + (n ? ' has' : '') +
        (state.activeLocId === c.id ? ' active' : '') + '" data-cell="' + esc(c.id) + '">' +
        '<span class="cell-n">' + esc(c.name) + '</span>' +
        '<span class="cell-c">' + (n ? n + ' 件' : '空') + '</span>' +
        // 编辑模式下给个删除角标，格子也要能删
        (state.editMode
          ? '<span class="cell-x" data-delcell="' + esc(c.id) + '">×</span>'
          : '') +
        '</button>';
    }).join('');
  }

  $('cells').addEventListener('click', function (e) {
    var del = e.target.closest ? e.target.closest('[data-delcell]') : null;
    if (del) {
      var cid = del.dataset.delcell;
      var cn = node(cid);
      if (!window.confirm('删除格子「' + (cn ? cn.name : '') +
          '」？\n里面的东西不会删，会变成未归档')) return;
      api('/api/locations/' + encodeURIComponent(cid), { method: 'DELETE' })
        .then(function () {
          if (state.renamingCell === cid) resetCellInput();
          toast('格子已删除');
          return Promise.all([loadLocations(), doSearch()]);
        })
        .then(function () { paintCells(); })
        .catch(function (err) { toast(err.message); });
      return;
    }
    var btn = e.target.closest ? e.target.closest('[data-cell]') : null;
    if (!btn) return;
    var n = node(btn.dataset.cell);
    if (!n) return;
    // 编辑模式下点格子 = 选中它去改名
    if (state.editMode) {
      state.renamingCell = n.id;
      $('cell-name').value = n.name;
      $('cell-name').placeholder = '改成新名字';
      $('add-cell').textContent = '改名';
      paintCells();
    }
    selectLocation(n.id, n.name, $('inner-detail')).then(function () {
      paintCells();
    });
  });

  $('inner-back').addEventListener('click', function () {
    state.innerId = null;
    $('map-home').hidden = false;
    $('map-inner').hidden = true;
    $('map-detail').innerHTML = '';
    paintPlan();
  });

  function resetCellInput() {
    state.renamingCell = null;
    $('cell-name').value = '';
    $('cell-name').placeholder = '加个格子，比如：中层左侧';
    $('add-cell').textContent = '添加';
  }

  $('add-cell').addEventListener('click', function () {
    var input = $('cell-name');
    var name = input.value.trim();
    if (!name) { toast('先给格子起个名'); return; }

    // 同一个输入框兼做「改名」，取决于是否选中了已有格子
    if (state.renamingCell) {
      var cid = state.renamingCell;
      api('/api/locations/' + encodeURIComponent(cid), {
        method: 'PUT', body: JSON.stringify({ name: name })
      }).then(function () {
        resetCellInput();
        return loadLocations();
      }).then(function () {
        paintCells();
        toast('已改名为：' + name);
      }).catch(function (err) { toast(err.message); });
      return;
    }

    api('/api/locations', {
      method: 'POST',
      body: JSON.stringify({ name: name, parent: state.innerId, kind: 'compartment' })
    }).then(function () {
      input.value = '';
      return loadLocations();
    }).then(function () {
      paintCells();
      toast('格子已添加：' + name);
    }).catch(function (err) { toast(err.message); });
  });

  /* ---------- 表单 ---------- */

  function renderFormSelects() {
    var cat = $('f-category');
    if (cat) {
      cat.innerHTML = '<option value="">未分类</option>' + CATEGORIES.map(function (c) {
        return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
      }).join('');
    }
    var st = $('f-state');
    if (st) {
      st.innerHTML = STATES.map(function (s) {
        return '<option value="' + esc(s.k) + '">' + esc(s.n) + '</option>';
      }).join('');
    }
    syncWearType();
  }

  // 归属人下拉：第一项「共用」，默认选当前登录人
  function renderOwnerSelect() {
    var sel = $('f-owner');
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '<option value="">共用</option>' + (state.auth.members || []).map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>';
    }).join('');
    var def = state.auth.me && state.auth.me.id !== 'm_bootstrap' ? state.auth.me.id : '';
    var want = keep || def;
    sel.value = want;
    if (sel.value !== want) sel.value = '';
  }

  var WEAR_TYPES_UI = [
    { k: 'top', n: '上衣' }, { k: 'bottom', n: '下装' }, { k: 'outer', n: '外套' },
    { k: 'dress', n: '连衣裙' }, { k: 'shoes', n: '鞋' }, { k: 'accessory', n: '配饰' }
  ];

  // 类目选「衣物」才显示衣物类型；选了才会进衣柜
  function syncWearType() {
    var row = $('f-weartype-row');
    if (!row) return;
    var sel = $('f-weartype');
    if (sel && !sel.options.length) {
      sel.innerHTML = WEAR_TYPES_UI.map(function (t) {
        return '<option value="' + t.k + '">' + t.n + '</option>';
      }).join('');
    }
    var on = !!$('f-category') && $('f-category').value === '衣物';
    row.hidden = !on;
  }

  // 「借给谁」只有状态是「借出了」才显示，否则留着只会让人困惑
  function syncLendField() {
    var box = $('f-lendto-field');
    if (!box) return;
    var st = $('f-state');
    var lent = !!st && st.value === 'lent';
    box.hidden = !lent;
    if (!lent && $('f-lendto')) $('f-lendto').value = '';
  }

  function resetMoreFields() {
    if ($('f-price')) $('f-price').value = '';
    if ($('f-buydate')) $('f-buydate').value = '';
    if ($('f-category')) $('f-category').value = '';
    if ($('f-weartype')) $('f-weartype').value = 'top';
    if ($('f-state')) $('f-state').value = 'in_use';
    if ($('f-expire')) $('f-expire').value = '';
    if ($('f-remind')) $('f-remind').value = '';
    if ($('f-minqty')) $('f-minqty').value = '';
    syncLendField();
    syncWearType();
  }

  function resetForm() {
    state.editingId = null;
    itemPhotos.reset(null);
    $('form-title').textContent = '记一件东西';
    $('submit-btn').textContent = '保存';
    $('cancel-edit').hidden = true;
    $('f-name').value = '';
    $('f-note').value = '';
    $('f-qty').value = '1';
    $('f-tags').value = '';
    resetMoreFields();
    renderOwnerSelect();
    if ($('f-more')) $('f-more').open = false;
  }

  // 连续录入时位置和归属人要留着，但照片和这件东西自己的金额必须清掉，
  // 否则上一件的照片/价格会被挂到下一件东西上
  function clearBodyKeepLocation() {
    itemPhotos.reset(null);
    $('f-name').value = '';
    $('f-note').value = '';
    $('f-qty').value = '1';
    $('f-tags').value = '';
    resetMoreFields();
    if ($('f-more')) $('f-more').open = false;
  }

  function startEdit(id) {
    if (!can('write')) { toast('当前身份只能看，不能改'); return; }
    var item = state.items.filter(function (i) { return i.id === id; })[0];
    if (!item) { toast('找不到这条记录，请重新搜索'); return; }
    state.editingId = id;
    $('form-title').textContent = '编辑：' + item.name;
    $('submit-btn').textContent = '更新';
    $('cancel-edit').hidden = false;
    $('f-name').value = item.name || '';
    $('f-loc').value = item.locId || '';
    $('f-qty').value = item.qty || 1;
    $('f-tags').value = (item.tags || []).join('、');
    $('f-note').value = item.note || '';
    $('f-price').value = item.priceCents != null ? item.priceCents / 100 : '';
    $('f-buydate').value = item.buyDate || '';
    $('f-category').value = item.category || '';
    $('f-state').value = item.state || 'in_use';
    if (item.wear && item.wear.type) $('f-weartype').value = item.wear.type;
    syncWearType();
    $('f-expire').value = item.expireAt || '';
    $('f-remind').value = item.remindDays == null ? '' : item.remindDays;
    $('f-minqty').value = item.minQty == null ? '' : item.minQty;
    $('f-lendto').value = item.lendTo || '';
    syncLendField();
    renderOwnerSelect();
    $('f-owner').value = item.ownerId || '';
    // 老数据这些字段都是空的，就不必展开折叠区
    if ($('f-more')) {
      $('f-more').open = !!(item.priceCents != null || item.buyDate ||
        item.category || (item.state && item.state !== 'in_use') ||
        item.expireAt || item.minQty != null);
    }
    itemPhotos.reset(item.photo);
    setTab('add');
    $('f-name').focus();
  }

  function removeItem(id) {
    if (!can('remove')) { toast('当前身份不能删东西'); return; }
    var item = state.items.filter(function (i) { return i.id === id; })[0];
    var label = item ? item.name : '这条记录';
    if (!window.confirm('确定删除「' + label + '」吗？')) return;
    api('/api/items/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () {
        toast('已删除');
        state.wb.stale = true;
        return Promise.all([loadLocations(), doSearch()]);
      })
      .catch(function (err) { toast(err.message); });
  }

  document.addEventListener('click', function (e) {
    var img = e.target.closest ? e.target.closest('[data-full]') : null;
    if (img) {
      openLightbox(img.getAttribute('data-full'), img.getAttribute('alt'));
      return;
    }
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    var id = btn.dataset.id;
    if (btn.dataset.act === 'edit') startEdit(id);
    if (btn.dataset.act === 'del') removeItem(id);
    if (btn.dataset.act === 'gedit') startGarmentEdit(id);
    if (btn.dataset.act === 'gdel') removeGarment(id);
    if (btn.dataset.act === 'wore') markWorn(id);
  });

  $('toggle-newloc').addEventListener('click', function () {
    var row = $('newloc-row');
    row.hidden = !row.hidden;
    if (!row.hidden) $('f-newloc').focus();
  });

  $('create-loc').addEventListener('click', function () {
    var name = $('f-newloc').value.trim();
    var parent = $('f-newloc-parent').value || null;
    if (!name) { toast('先给位置起个名'); return; }
    api('/api/locations', {
      method: 'POST',
      body: JSON.stringify({ name: name, parent: parent, kind: parent ? 'compartment' : 'home' })
    }).then(function (data) {
      $('f-newloc').value = '';
      return loadLocations().then(function () {
        $('f-loc').value = data.location.id;
        $('newloc-row').hidden = true;
        toast('位置已创建：' + name);
      });
    }).catch(function (err) { toast(err.message); });
  });

  $('cancel-edit').addEventListener('click', function () {
    resetForm();
    setTab('search');
  });

  // 状态切到「借出了」才露出「借给谁」
  $('f-state').addEventListener('change', syncLendField);
  $('f-category').addEventListener('change', syncWearType);

  $('item-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('write')) { toast('当前身份只能看，不能记东西'); return; }

    var payload = {
      name: $('f-name').value.trim(),
      locId: $('f-loc').value || null,
      qty: Number($('f-qty').value) || 1,
      tags: $('f-tags').value,
      note: $('f-note').value.trim(),
      category: $('f-category').value || null,
      buyDate: $('f-buydate').value || null,
      ownerId: $('f-owner').value || null,
      state: $('f-state').value || 'in_use',
      // 提醒字段：留空一律传 null，表示「不提醒」，绝不给默认日期
      expireAt: $('f-expire').value || null,
      remindDays: $('f-remind').value === '' ? null : Number($('f-remind').value),
      minQty: $('f-minqty').value === '' ? null : Number($('f-minqty').value),
      // 类目是衣物时，把这个类型交给服务端生成 wear，衣柜才看得到
      wearType: $('f-category').value === '衣物' ? ($('f-weartype').value || 'top') : null,
      lendTo: $('f-state').value === 'lent' ? ($('f-lendto').value.trim() || null) : null
    };
    if (!payload.name) { toast('总得有个名字吧'); return; }

    // 价格只在看得到的身份下提交；留空就显式传 null（编辑时才能清掉旧价）
    if (can('seePrice')) {
      var raw = $('f-price').value.trim();
      if (raw !== '') {
        var yuan = Number(raw);
        if (!isFinite(yuan) || yuan < 0) { toast('金额填个正数，或者留空'); return; }
        payload.price = yuan;
      } else {
        payload.price = null;
      }
    }

    var isEdit = !!state.editingId;
    var targetId = state.editingId;
    var req = isEdit
      ? api('/api/items/' + encodeURIComponent(targetId), {
          method: 'PUT', body: JSON.stringify(payload)
        })
      : api('/api/items', { method: 'POST', body: JSON.stringify(payload) });

    req.then(function (data) {
      // 先拿到 id 才能往这件东西上挂照片
      var id = isEdit ? targetId : (data && data.item ? data.item.id : null);
      var job = id ? itemPhotos.commit(id) : null;
      // 照片没传成功不该把整条记录一起回滚，报个错让它继续往下走
      var photoStep = job
        ? job.req.catch(function (err) {
            toast('东西已经记下了，但照片没传成功：' + err.message);
            return null;
          })
        : Promise.resolve(null);

      return photoStep.then(function () {
        if (isEdit) {
          resetForm();
          setTab('search');
          toast('已更新');
          return Promise.all([doSearch(), loadStats()]);
        }
        toast('记下了：' + payload.name + '（位置保留着，接着录下一件）');
        clearBodyKeepLocation();
        $('f-name').focus();
        return Promise.all([loadLocations(), loadItems(''), loadStats()]).then(function () {
          renderStats();
          renderCharts();
        });
      });
    }).then(function () {
      if (!isEdit) doSearch();
    }).catch(function (err) { toast(err.message); });
  });

  /* ---------- 衣柜：找衣服 ---------- */

  var COLOR_MAP = {
    black: { n: '黑', hex: '#33312f' },
    white: { n: '白', hex: '#f6f2ea' },
    gray: { n: '灰', hex: '#9c9c9c' },
    navy: { n: '藏青', hex: '#2b3a55' },
    blue: { n: '蓝', hex: '#4a7fb5' },
    denim: { n: '牛仔', hex: '#5b7fa6' },
    green: { n: '绿', hex: '#5f8a5f' },
    khaki: { n: '卡其', hex: '#b09a72' },
    beige: { n: '米', hex: '#ded2ba' },
    brown: { n: '棕', hex: '#7b5b3a' },
    red: { n: '红', hex: '#b03a3a' },
    pink: { n: '粉', hex: '#e0a0ac' },
    orange: { n: '橙', hex: '#d4823c' },
    yellow: { n: '黄', hex: '#ddb84a' },
    purple: { n: '紫', hex: '#7b5fa0' }
  };

  function colorName(k) { return COLOR_MAP[k] ? COLOR_MAP[k].n : k; }
  function colorHex(k) { return COLOR_MAP[k] ? COLOR_MAP[k].hex : '#cdc6b8'; }

  function dictN(list, k) {
    for (var i = 0; i < list.length; i += 1) if (list[i].k === k) return list[i].n;
    return k;
  }
  function typeN(k) { return state.wb.dict ? dictN(state.wb.dict.types, k) : k; }
  function seasonN(k) { return state.wb.dict ? dictN(state.wb.dict.seasons, k) : k; }
  function statusN(k) { return state.wb.dict ? dictN(state.wb.dict.status, k) : k; }

  // 多色时用斜向渐变拼成一块，一眼看出是双色还是纯色
  function swatchCss(colors) {
    var list = (colors || []).map(colorHex);
    if (!list.length) return 'background:#e8e2d6';
    if (list.length === 1) return 'background:' + list[0];
    return 'background:linear-gradient(135deg,' + list.join(',') + ')';
  }

  function loadWardrobe() {
    return api('/api/wardrobe').then(function (data) {
      state.wb.loaded = true;
      state.wb.stale = false;
      state.wb.items = data.items;
      state.wb.dict = data.dict;
      state.wb.facets = data.facets;
      if (!state.wb.pickedSeason) state.wb.pickedSeason = data.season;
      buildGarmentForm();
      paintSeasonSeg();
      renderWbStats();
      renderChips();
      renderGarments();
      return suggestOutfit();
    }).catch(function (err) {
      if ($('garments')) {
        $('garments').innerHTML = '<p class="empty">衣柜加载失败：' + esc(err.message) + '</p>';
      }
    });
  }

  function paintSeasonSeg() {
    Array.prototype.forEach.call(document.querySelectorAll('#season-seg .seg'), function (b) {
      b.classList.toggle('is-active', b.dataset.season === state.wb.pickedSeason);
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('#season-seg .seg'), function (b) {
    b.addEventListener('click', function () {
      state.wb.pickedSeason = b.dataset.season;
      paintSeasonSeg();
      renderWbStats();
      suggestOutfit();
    });
  });

  function suggestOutfit() {
    var url = '/api/wardrobe/suggest?season=' + encodeURIComponent(state.wb.pickedSeason);
    // 共用（空归属）后端没有对应的筛选参数，只能看全部——这里不传
    var owner = state.wb.filters.owner;
    if (owner && owner !== '__shared__') url += '&ownerId=' + encodeURIComponent(owner);
    return api(url)
      .then(function (data) { renderOutfit(data); })
      .catch(function (err) {
        $('outfit').innerHTML = '<p class="hint">' + esc(err.message) + '</p>';
      });
  }

  function outfitRow(label, item) {
    if (!item) {
      return '<div class="orow miss"><span class="orole">' + esc(label) + '</span>' +
        '<span class="oval">这一类还没有，添一件吧</span></div>';
    }
    var w = item.wear;
    return '<div class="orow">' +
      '<span class="oswatch" style="' + swatchCss(w.colors) + '"></span>' +
      '<span class="obody">' +
        '<span class="orole">' + esc(label) + '</span>' +
        '<span class="oname">' + esc(item.name) + '</span>' +
        '<span class="opath">' + esc(item.path) + '</span>' +
      '</span>' +
      '<span class="oval">' +
        esc((w.colors || []).map(colorName).join('/') || '—') +
        (w.size ? ' · ' + esc(w.size) : '') +
      '</span>' +
    '</div>';
  }

  function renderOutfit(data) {
    if (!data.poolSize) {
      $('outfit').innerHTML = '<p class="hint">这个季节还没有可穿的衣服，先在下面添一件</p>';
      return;
    }
    var o = data.outfit;
    var rows = o.dress
      ? outfitRow('连衣裙', o.dress)
      : outfitRow('上衣', o.top) + outfitRow('下装', o.bottom);
    rows += outfitRow('外套', o.outer);
    rows += outfitRow('鞋', o.shoes);
    if (o.accessory) rows += outfitRow('配饰', o.accessory);
    $('outfit').innerHTML =
      '<p class="outfit-note">从当季可穿的 ' + data.poolSize + ' 件里挑出来的</p>' + rows;
  }

  function renderWbStats() {
    var items = state.wb.items;
    var season = state.wb.pickedSeason;
    var ready = items.filter(function (i) {
      var w = i.wear;
      return w.status === 'ready' && (!w.seasons.length || w.seasons.indexOf(season) !== -1);
    }).length;
    var away = items.filter(function (i) { return i.wear.status !== 'ready'; }).length;
    $('wb-total').textContent = items.length;
    $('wb-ready').textContent = ready;
    $('wb-away').textContent = away;
  }

  function chipHtml(box, dim, pairs) {
    var html = '<button type="button" class="chip' +
      (state.wb.filters[dim] === '' ? ' is-on' : '') +
      '" data-dim="' + dim + '" data-val="">全部</button>';
    html += pairs.map(function (p) {
      return '<button type="button" class="chip' +
        (state.wb.filters[dim] === p.k ? ' is-on' : '') +
        '" data-dim="' + dim + '" data-val="' + esc(p.k) + '">' +
        (p.dot ? '<span class="cdot" style="background:' + p.dot + '"></span>' : '') +
        esc(p.n) + '<span class="cn">' + p.c + '</span></button>';
    }).join('');
    box.innerHTML = html;
  }

  function renderChips() {
    var f = state.wb.facets;
    var d = state.wb.dict;
    if (!f || !d) return;
    var owners = f.owners || {};
    chipHtml($('chip-owner'), 'owner', Object.keys(owners).map(function (k) {
      // 后端的 key 是 ownerId，空字符串代表共用；下拉里用哨兵避开「全部」的空值
      return { k: k || '__shared__', n: k ? memberName(k) : '共用', c: owners[k] };
    }).filter(function (x) { return x.c > 0; }));
    chipHtml($('chip-type'), 'type', d.types
      .map(function (t) { return { k: t.k, n: t.n, c: f.types[t.k] || 0 }; })
      .filter(function (x) { return x.c > 0; }));
    chipHtml($('chip-season'), 'season', d.seasons
      .map(function (s) { return { k: s.k, n: s.n, c: f.seasons[s.k] || 0 }; })
      .filter(function (x) { return x.c > 0; }));
    chipHtml($('chip-color'), 'color', Object.keys(f.colors)
      .map(function (k) { return { k: k, n: colorName(k), c: f.colors[k], dot: colorHex(k) }; })
      .filter(function (x) { return x.c > 0; }));
    chipHtml($('chip-status'), 'status', d.status
      .map(function (s) { return { k: s.k, n: s.n, c: f.status[s.k] || 0 }; })
      .filter(function (x) { return x.c > 0; }));
  }

  ['chip-owner', 'chip-type', 'chip-season', 'chip-color', 'chip-status'].forEach(function (id) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.chip') : null;
      if (!b) return;
      var dim = b.dataset.dim;
      state.wb.filters[dim] = b.dataset.val;
      renderChips();
      renderGarments();
      // 「今日穿什么」跟着归属人走
      if (dim === 'owner') suggestOutfit();
    });
  });

  $('clear-filter').addEventListener('click', function () {
    state.wb.filters = { type: '', season: '', color: '', status: '', owner: '' };
    renderChips();
    renderGarments();
    suggestOutfit();
  });

  function filteredGarments() {
    var f = state.wb.filters;
    return state.wb.items.filter(function (i) {
      var w = i.wear;
      if (f.type && w.type !== f.type) return false;
      if (f.season && (w.seasons || []).indexOf(f.season) === -1) return false;
      if (f.color && (w.colors || []).indexOf(f.color) === -1) return false;
      if (f.status && w.status !== f.status) return false;
      if (f.owner === '__shared__') {
        if (i.ownerId) return false;
      } else if (f.owner && i.ownerId !== f.owner) {
        return false;
      }
      return true;
    });
  }

  function wornText(w) {
    if (!w.lastWorn) return '还没穿过';
    var d = w.idleDays;
    if (d == null) return '穿过 ' + (w.wearCount || 0) + ' 次';
    if (d === 0) return '今天穿过';
    if (d === 1) return '昨天穿过';
    return d + ' 天前穿过';
  }

  function garmentCard(g) {
    var w = g.wear;
    var meta = [typeN(w.type), w.size ? '尺码 ' + w.size : '',
      (w.colors || []).map(colorName).join('/')].filter(Boolean).join(' · ');
    var badge = w.status !== 'ready'
      ? '<span class="gbadge ' + esc(w.status) + '">' + esc(statusN(w.status)) + '</span>'
      : '';
    // 衣服也会过期（香水、护肤品）或低于库存，和搜索卡片同一套判断
    var stock = stockBadges(g).map(function (b) {
      return '<span class="gbadge ' + b.k + '">' + esc(b.t) + '</span>';
    }).join('');
    var occasions = (w.occasions && w.occasions.length) ? ' · ' + w.occasions.join('/') : '';
    // 有照片就用照片，没照片才退回到色块
    var media = g.photo
      ? '<img class="gsw is-photo" src="' + esc(photoUrl(g.photo)) + '" loading="lazy"' +
        ' alt="' + esc(g.name) + '" data-full="' + esc(photoUrl(g.photo)) + '" />'
      : '<span class="gsw" style="' + swatchCss(w.colors) + '"></span>';
    var acts = '';
    if (can('write')) {
      acts += '<button type="button" class="mini" data-act="wore" data-id="' + esc(g.id) + '">今天穿了</button>' +
        '<button type="button" class="mini" data-act="gedit" data-id="' + esc(g.id) + '">编辑</button>';
    }
    if (can('remove')) {
      acts += '<button type="button" class="mini danger" data-act="gdel" data-id="' + esc(g.id) + '">删除</button>';
    }
    return '<article class="gcard">' +
      media +
      '<span class="gbody">' +
        '<span class="gtop"><span class="gname">' + esc(g.name) + '</span>' + badge + stock +
          '<span class="gbadge own">' + esc(memberName(g.ownerId)) + '</span></span>' +
        '<span class="gmeta">' + esc(meta) + '</span>' +
        '<span class="gpath">' + esc(g.path) + '</span>' +
        '<span class="gfoot">' + esc(wornText(w)) + ' · 共 ' + (w.wearCount || 0) + ' 次' +
          esc(occasions) + '</span>' +
      '</span>' +
      (acts ? '<span class="gacts">' + acts + '</span>' : '') +
    '</article>';
  }

  function renderGarments() {
    var box = $('garments');
    if (!state.wb.items.length) {
      box.innerHTML = '<div class="empty-box">' +
        '<p class="empty">衣柜还是空的</p>' +
        (can('write')
          ? '<button id="load-demo" class="mini">放几件示例衣服进来看看效果</button>'
          : '') +
        '</div>';
      var btn = $('load-demo');
      if (btn) btn.addEventListener('click', loadDemo);
      $('filter-count').textContent = '';
      return;
    }
    var list = filteredGarments();
    $('filter-count').textContent = '筛出 ' + list.length + ' / ' + state.wb.items.length + ' 件';
    if (!list.length) {
      box.innerHTML = '<p class="empty">没有符合条件的衣服，换个条件试试</p>';
      return;
    }
    box.innerHTML = '<div class="ggrid">' + list.map(garmentCard).join('') + '</div>';
  }

  function loadDemo() {
    if (!can('write')) { toast('当前身份不能加东西'); return; }
    api('/api/wardrobe/demo', { method: 'POST' }).then(function (data) {
      toast('已放入 ' + data.added + ' 件示例衣服（放进「' + data.wardrobe + '」）');
      return Promise.all([loadLocations(), loadWardrobe(), doSearch()]);
    }).catch(function (err) { toast(err.message); });
  }

  /* ---------- 衣物表单 ---------- */

  function buildGarmentForm() {
    var d = state.wb.dict;
    if (!d || $('g-type').options.length) return;
    $('g-type').innerHTML = d.types.map(function (t) {
      return '<option value="' + esc(t.k) + '">' + esc(t.n) + '</option>';
    }).join('');
    $('g-status').innerHTML = d.status.map(function (s) {
      return '<option value="' + esc(s.k) + '">' + esc(s.n) + '</option>';
    }).join('');
    $('g-seasons').innerHTML = d.seasons.map(function (s) {
      return '<button type="button" class="tgl" data-season="' + esc(s.k) + '">' +
        esc(s.n) + '</button>';
    }).join('');
    $('g-colors').innerHTML = Object.keys(COLOR_MAP).map(function (k) {
      return '<button type="button" class="tgl" data-color="' + esc(k) + '">' +
        '<span class="cdot" style="background:' + COLOR_MAP[k].hex + '"></span>' +
        esc(COLOR_MAP[k].n) + '</button>';
    }).join('');
  }

  function bindToggleSet(id) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.tgl') : null;
      if (!b) return;
      b.classList.toggle('is-on');
    });
  }
  bindToggleSet('g-seasons');
  bindToggleSet('g-colors');

  function toggleVals(box, key) {
    return Array.prototype.map.call(box.querySelectorAll('.tgl.is-on'), function (b) {
      return b.dataset[key];
    });
  }

  function clearGarmentFields() {
    garmentPhotos.reset(null);
    $('garment-form').reset();
    Array.prototype.forEach.call($('g-seasons').querySelectorAll('.tgl'), function (b) {
      b.classList.remove('is-on');
    });
    Array.prototype.forEach.call($('g-colors').querySelectorAll('.tgl'), function (b) {
      b.classList.remove('is-on');
    });
  }

  function closeGarmentForm() {
    $('garment-form').hidden = true;
    $('toggle-gform').textContent = '+ 添一件衣服';
    state.wb.editingId = null;
    $('g-submit').textContent = '保存';
    $('g-cancel').hidden = true;
  }

  $('toggle-gform').addEventListener('click', function () {
    if ($('garment-form').hidden) {
      if (!state.wb.editingId) clearGarmentFields();
      $('garment-form').hidden = false;
      this.textContent = '收起表单';
    } else {
      closeGarmentForm();
    }
  });

  $('g-cancel').addEventListener('click', function () {
    clearGarmentFields();
    closeGarmentForm();
  });

  function startGarmentEdit(id) {
    if (!can('write')) { toast('当前身份只能看，不能改'); return; }
    var g = state.wb.items.filter(function (x) { return x.id === id; })[0];
    if (!g) { toast('找不到这件衣服'); return; }
    var w = g.wear;
    state.wb.editingId = id;
    $('g-name').value = g.name || '';
    $('g-size').value = w.size || '';
    $('g-note').value = g.note || '';
    $('g-occasions').value = (w.occasions || []).join('、');
    $('g-type').value = w.type || 'top';
    $('g-status').value = w.status || 'ready';
    $('g-loc').value = g.locId || '';
    garmentPhotos.reset(g.photo);
    Array.prototype.forEach.call($('g-seasons').querySelectorAll('.tgl'), function (b) {
      b.classList.toggle('is-on', (w.seasons || []).indexOf(b.dataset.season) !== -1);
    });
    Array.prototype.forEach.call($('g-colors').querySelectorAll('.tgl'), function (b) {
      b.classList.toggle('is-on', (w.colors || []).indexOf(b.dataset.color) !== -1);
    });
    $('garment-form').hidden = false;
    $('toggle-gform').textContent = '收起表单';
    $('g-submit').textContent = '更新';
    $('g-cancel').hidden = false;
    setTab('wardrobe');
    $('garment-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('garment-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('write')) { toast('当前身份只能看，不能记衣服'); return; }
    var name = $('g-name').value.trim();
    if (!name) { toast('总得有个名字吧'); return; }
    var isEdit = !!state.wb.editingId;
    var wear = {
      type: $('g-type').value,
      size: $('g-size').value.trim(),
      seasons: toggleVals($('g-seasons'), 'season'),
      colors: toggleVals($('g-colors'), 'color'),
      occasions: $('g-occasions').value.split(/[,，、\s]+/)
        .map(function (s) { return s.trim(); }).filter(Boolean),
      status: $('g-status').value
    };
    var payload = {
      name: name, locId: $('g-loc').value || null,
      note: $('g-note').value.trim(), tags: [], wear: wear
    };
    if (isEdit) {
      // 穿着历史不在表单里，编辑时要原样带回去
      var cur = state.wb.items.filter(function (x) { return x.id === state.wb.editingId; })[0];
      if (cur) {
        wear.wearCount = cur.wear.wearCount || 0;
        wear.lastWorn = cur.wear.lastWorn || null;
      }
    }
    var req = isEdit
      ? api('/api/items/' + encodeURIComponent(state.wb.editingId), {
          method: 'PUT', body: JSON.stringify(payload)
        })
      : api('/api/items', { method: 'POST', body: JSON.stringify(payload) });

    req.then(function (data) {
      var id = isEdit ? state.wb.editingId : (data && data.item ? data.item.id : null);
      var job = id ? garmentPhotos.commit(id) : null;
      var photoStep = job
        ? job.req.catch(function (err) {
            toast('衣服已经记下了，但照片没传成功：' + err.message);
            return null;
          })
        : Promise.resolve(null);

      return photoStep.then(function () {
        clearGarmentFields();
        closeGarmentForm();
        state.wb.stale = true;
        toast(isEdit ? '已更新' : '记下了：' + name);
        return Promise.all([loadLocations(), loadWardrobe(), doSearch()]);
      });
    }).catch(function (err) { toast(err.message); });
  });

  function markWorn(id) {
    if (!can('write')) { toast('当前身份只能看，不能记穿着'); return; }
    api('/api/items/' + encodeURIComponent(id) + '/wear', {
      method: 'POST', body: JSON.stringify({ laundry: true })
    }).then(function () {
      toast('记下了，已移到待洗');
      state.wb.stale = true;
      return Promise.all([loadWardrobe(), doSearch()]);
    }).catch(function (err) { toast(err.message); });
  }

  function removeGarment(id) {
    if (!can('remove')) { toast('当前身份不能删东西'); return; }
    var g = state.wb.items.filter(function (x) { return x.id === id; })[0];
    if (!window.confirm('确定删除「' + (g ? g.name : '这件衣服') + '」吗？')) return;
    api('/api/items/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
      toast('已删除');
      state.wb.stale = true;
      if (state.wb.editingId === id) { clearGarmentFields(); closeGarmentForm(); }
      return Promise.all([loadLocations(), loadWardrobe(), doSearch()]);
    }).catch(function (err) { toast(err.message); });
  }

  $('outfit-reroll').addEventListener('click', function () { suggestOutfit(); });

  /* ---------- 提醒 ----------
     后端只给数据和分类，人话说明在这里拼：一句话说清「还有几天 / 还剩几个 / 借了多久」，
     不用让用户自己换算 daysLeft。 */

  var REMIND_ORDER = ['expire', 'lowStock', 'lent', 'idle'];
  var REMIND_EMPTY = '<div class="rm-empty">' +
    '<p class="rm-empty-t">暂时没有要操心的事</p>' +
    '<p class="rm-empty-s">给东西填上过期日期或最低库存后，这里会自动提醒。</p>' +
    '</div>';

  var ACK_TEXT = {
    done: '已处理，今天不再出现',
    snooze: '好，7 天后再提醒你',
    mute: '这件以后不再提醒'
  };

  function loadReminders() {
    return api('/api/reminders').then(function (data) {
      state.remind.data = data;
      paintTabDot(data.counts);
      if (state.tab === 'reminders') renderReminders();
      return data;
    });
  }

  // 红点：进页面不消失，只有处理掉或刷新时后端不再返回才减
  function paintTabDot(counts) {
    var el = $('tab-dot');
    if (!el) return;
    var n = counts && counts.total ? Number(counts.total) : 0;
    el.hidden = n <= 0;
    el.textContent = n > 9 ? '9+' : String(n);
  }

  /**
   * 一条提醒的人话说明。
   * @param {string} kind expire|lowStock|lent|idle
   * @param {object} e 提醒条目
   * @returns {{t:string, warn:boolean}} warn = 要标红
   */
  function reminderText(kind, e) {
    if (kind === 'expire') {
      var left = Number(e.daysLeft);
      if (left < 0) return { t: '已过期 ' + Math.abs(left) + ' 天', warn: true };
      if (left === 0) return { t: '今天到期', warn: true };
      return { t: '还有 ' + left + ' 天到期（' + e.expireAt + '）', warn: false };
    }
    if (kind === 'lowStock') {
      return { t: '只剩 ' + e.qty + ' 个，低于你设的 ' + e.minQty + ' 个', warn: false };
    }
    if (kind === 'lent') {
      return { t: '借给' + (e.lendTo || '别人') + ' ' + e.daysLent + ' 天了', warn: false };
    }
    if (kind === 'idle') return { t: '已经 ' + e.idleDays + ' 天没动过', warn: false };
    return { t: '', warn: false };
  }

  function reminderCard(kind, e) {
    var line = reminderText(kind, e);
    var acts = '';
    if (can('write')) {
      var attrs = ' data-id="' + esc(e.id) + '" data-kind="' + esc(kind) + '"';
      acts = '<div class="rm-acts">' +
        '<button type="button" class="mini" data-rm="done"' + attrs + '>已处理</button>' +
        '<button type="button" class="mini" data-rm="snooze"' + attrs + '>稍后 7 天</button>' +
        '<button type="button" class="mini" data-rm="mute"' + attrs + '>不再提醒</button>' +
      '</div>';
    }
    return '<article class="rm-card" role="button" tabindex="0" data-rm-open="1"' +
        ' data-name="' + esc(e.name) + '" data-id="' + esc(e.id) + '">' +
      '<div class="rm-top">' +
        '<span class="rm-name">' + esc(e.name) + '</span>' +
        '<span class="rm-qty">×' + esc(e.qty || 1) + '</span>' +
      '</div>' +
      '<p class="rm-path">' + esc(e.path || '未归档') + '</p>' +
      '<p class="rm-line' + (line.warn ? ' is-warn' : '') + '">' + esc(line.t) + '</p>' +
      acts +
    '</article>';
  }

  function renderReminders() {
    var data = state.remind.data;
    var box = $('rm-groups');
    if (!data) {
      $('rm-summary').textContent = '正在看看今天有什么…';
      box.innerHTML = '<p class="hint">正在读取…</p>';
      return;
    }
    var total = data.counts ? data.counts.total : 0;
    $('rm-summary').textContent = total
      ? '今天有 ' + total + ' 件事要留意'
      : '今天没有要处理的';

    var labels = data.labels || {};
    var html = '';
    REMIND_ORDER.forEach(function (kind) {
      var list = (data.groups && data.groups[kind]) || [];
      if (!list.length) return;
      html += '<section class="rm-group">' +
        '<p class="rm-gtitle">' + esc(labels[kind] || kind) +
          '<span class="rm-count">' + list.length + '</span></p>' +
        list.map(function (e) { return reminderCard(kind, e); }).join('') +
      '</section>';
    });
    box.innerHTML = html || REMIND_EMPTY;
  }

  // 点卡片主体 → 去「找东西」里搜它。复用现成的搜索链路，不另写一套。
  function jumpToSearch(name) {
    state.query = String(name || '');
    $('search').value = state.query;
    setTab('search');
    doSearch();
  }

  // 先本地摘掉再重新拉：网络慢的时候也不会看到刚处理完的条目赖着不动
  function removeReminderLocally(id, kind) {
    var data = state.remind.data;
    if (!data || !data.groups || !data.groups[kind]) return;
    data.groups[kind] = data.groups[kind].filter(function (x) { return x.id !== id; });
    if (data.counts) {
      data.counts[kind] = data.groups[kind].length;
      data.counts.total = REMIND_ORDER.reduce(function (n, k) {
        return n + ((data.groups[k] || []).length);
      }, 0);
    }
    paintTabDot(data.counts);
    renderReminders();
  }

  function sendAck(id, kind, action, btn) {
    if (!can('write')) { toast('当前身份只能看'); return; }
    if (btn) btn.disabled = true;
    api('/api/reminders/' + encodeURIComponent(id) + '/' + encodeURIComponent(kind) + '/ack', {
      method: 'POST', body: JSON.stringify({ action: action })
    }).then(function () {
      toast(ACK_TEXT[action] || '已处理');
      removeReminderLocally(id, kind);
      return loadReminders();
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      toast(err.message);
    });
  }

  $('rm-groups').addEventListener('click', function (e) {
    var ack = e.target.closest ? e.target.closest('[data-rm]') : null;
    if (ack) {
      sendAck(ack.dataset.id, ack.dataset.kind, ack.dataset.rm, ack);
      return;
    }
    var card = e.target.closest ? e.target.closest('[data-rm-open]') : null;
    if (card) jumpToSearch(card.dataset.name);
  });

  // 卡片是 role=button，键盘也要能进去
  $('rm-groups').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var card = e.target.closest ? e.target.closest('[data-rm-open]') : null;
    if (!card) return;
    e.preventDefault();
    jumpToSearch(card.dataset.name);
  });

  $('rm-refresh').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    loadReminders().then(function () {
      btn.disabled = false;
    }).catch(function (err) {
      btn.disabled = false;
      toast(err.message);
    });
  });

  /* ---------- 设置（仅管理员） ---------- */

  var MAIL_PRESETS = {
    qq: { host: 'smtp.qq.com', port: 465 },
    163: { host: 'smtp.163.com', port: 465 }
  };

  var JOB_STATUS_TEXT = { ok: '成功', failed: '失败', skipped: '跳过', running: '进行中' };
  var MAIL_STATUS_TEXT = { sent: '已发送', failed: '失败', pending: '待发送' };

  function openSettings() {
    if (!can('settings')) return;
    if (state.tab !== 'settings') state.prevTab = state.tab;
    setTab('settings');
    window.scrollTo(0, 0);
    loadNotifySettings();
    loadBackupStatus();
    loadJobStatus();
  }

  $('settings-back').addEventListener('click', function () {
    setTab(state.prevTab === 'settings' ? 'search' : (state.prevTab || 'search'));
  });

  function toggleCustomMail(preset) {
    var box = $('s-mail-custom');
    if (box) box.hidden = preset !== 'custom';
  }

  function syncIdleInput() {
    var box = $('s-idle-days');
    if (box) box.disabled = !$('s-kind-idle').checked;
  }

  function loadNotifySettings() {
    return api('/api/notify/settings').then(function (data) {
      state.notify.settings = data.settings;
      paintNotifySettings(data.settings);
    }).catch(function (err) {
      showMsg('s-mail-msg', '读不到设置：' + err.message, true);
    });
  }

  function paintNotifySettings(s) {
    if (!s) return;
    var mail = s.mail || {};
    $('s-mail-enabled').checked = !!mail.enabled;
    $('s-mail-preset').value = mail.preset || 'custom';
    $('s-mail-host').value = mail.host || '';
    $('s-mail-port').value = mail.port || 465;
    $('s-mail-user').value = mail.user || '';
    $('s-mail-to').value = mail.to || '';
    $('s-mail-time').value = mail.time || '08:30';
    // 授权码永远拿不到明文：只在有值时换个 placeholder 提示「已保存」
    var pass = $('s-mail-pass');
    pass.value = '';
    pass.placeholder = mail.hasPass ? '已保存，留空表示不修改' : 'QQ 邮箱的授权码，不是登录密码';
    toggleCustomMail(mail.preset || 'custom');

    var kinds = s.kinds || {};
    $('s-kind-expire').checked = !!kinds.expire;
    $('s-kind-lowstock').checked = !!kinds.lowStock;
    $('s-kind-lent').checked = !!kinds.lent;
    $('s-kind-idle').checked = !!kinds.idle;
    $('s-expire-days').value = s.expireDays == null ? 7 : s.expireDays;
    $('s-idle-days').value = s.idleDays == null ? 365 : s.idleDays;
    syncIdleInput();

    var b = s.backup || {};
    $('s-backup-dir').value = b.dir || '';
    $('s-backup-warn').hidden = !!b.dir;

    var ai = s.ai || {};
    $('s-ai-enabled').checked = !!ai.enabled;
    $('s-ai-preset').value = ai.preset || 'custom';
    $('s-ai-baseurl').value = ai.baseUrl || '';
    $('s-ai-model').value = ai.model || '';
    // Key 同样只进不出：有值就换个占位提示，输入框永远清空
    var keyEl = $('s-ai-key');
    keyEl.value = '';
    keyEl.placeholder = ai.hasKey ? '已保存，留空表示不修改' : '粘贴 API Key';
    // 配了 Key 却忘了开开关 —— 这是最容易让人以为「功能没生效」的一步
    var offHint = $('s-ai-off-hint');
    if (offHint) offHint.hidden = !(ai.hasKey && !ai.enabled);
  }

  $('s-ai-enable-now').addEventListener('click', function () {
    $('s-ai-enabled').checked = true;
    $('s-ai-save').click();
  });

  $('s-ai-preset').addEventListener('change', function () {
    var p = AI_PRESETS[this.value];
    if (p) {
      $('s-ai-baseurl').value = p.baseUrl;
      $('s-ai-model').value = p.model;
    }
  });

  $('s-ai-save').addEventListener('click', function () {
    var btn = this;
    var payload = {
      ai: {
        enabled: $('s-ai-enabled').checked,
        preset: $('s-ai-preset').value,
        baseUrl: $('s-ai-baseurl').value.trim(),
        model: $('s-ai-model').value.trim()
      }
    };
    var key = $('s-ai-key').value.trim();
    if (key) payload.ai.apiKey = key;
    btn.disabled = true;
    api('/api/notify/settings', { method: 'PUT', body: JSON.stringify(payload) })
      .then(function (data) {
        $('s-ai-key').value = '';
        paintNotifySettings(data.settings);
        refreshAiStatus();
    watchVersion();
        showMsg('s-ai-msg', '已保存', false);
        // 保存了但没开开关，是最容易让人以为「没生效」的地方，必须说清楚
        toast(payload.ai.enabled ? '识别已启用，去「记一件」看看' : '已保存，但识别仍是关闭状态');
      })
      .catch(function (err) {
        showMsg('s-ai-msg', err.message, true);
      })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- 导出 / 回灌 ---------- */

  $('s-export').addEventListener('click', function () {
    // 用浏览器原生下载：接口带 Content-Disposition，cookie 会自动带上
    window.location.href = '/api/export';
  });

  var importDoc = null;

  $('s-import-pick').addEventListener('click', function () {
    $('s-import-file').click();
  });

  $('s-import-file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onerror = function () { showMsg('s-data-msg', '这个文件读不出来', true); };
    reader.onload = function () {
      var doc;
      try {
        doc = JSON.parse(String(reader.result));
      } catch (err) {
        showMsg('s-data-msg', '不是有效的 JSON 文件', true);
        return;
      }
      if (!doc || !Array.isArray(doc.locations) || !Array.isArray(doc.items)) {
        showMsg('s-data-msg', '这个文件里没有位置和物品，可能不是 HomeBox 导出的', true);
        return;
      }
      importDoc = doc;
      $('s-data-msg').hidden = true;
      $('s-import-info').textContent = '文件里有 ' + doc.locations.length + ' 个位置、' +
        doc.items.length + ' 件物品。确认后会**整体替换**现在的数据。';
      $('s-import-confirm').hidden = false;
    };
    reader.readAsText(file);
  });

  $('s-import-cancel').addEventListener('click', function () {
    importDoc = null;
    $('s-import-confirm').hidden = true;
  });

  $('s-import-do').addEventListener('click', function () {
    if (!importDoc) return;
    var btn = this;
    btn.disabled = true;
    api('/api/import', {
      method: 'POST',
      body: JSON.stringify({ document: importDoc, confirm: 'REPLACE' })
    }).then(function (data) {
      importDoc = null;
      $('s-import-confirm').hidden = true;
      toast('已回灌：' + data.counts.locations + ' 个位置、' + data.counts.items + ' 件物品');
      // 数据整体换了，位置下拉、列表、提醒、统计都要重来
      Promise.all([loadLocations(), doSearch(), loadReminders(), loadStats()])
        .then(function () { renderFormSelects(); })
        .catch(function () { /* 刷新失败不影响回灌结果 */ });
    }).catch(function (err) {
      showMsg('s-data-msg', err.message, true);
    }).then(function () { btn.disabled = false; });
  });

  $('s-mail-preset').addEventListener('change', function () {
    var p = MAIL_PRESETS[this.value];
    if (p) {
      $('s-mail-host').value = p.host;
      $('s-mail-port').value = p.port;
    }
    toggleCustomMail(this.value);
  });

  $('s-mail-pass-help-btn').addEventListener('click', function () {
    var box = $('s-mail-pass-help');
    box.hidden = !box.hidden;
  });

  $('s-kind-idle').addEventListener('change', syncIdleInput);

  function collectMailPatch() {
    var preset = $('s-mail-preset').value;
    var host = $('s-mail-host').value.trim();
    var port = Number($('s-mail-port').value) || 465;
    // 预设优先：用户选了 QQ/163 就不该被输入框里的旧值带跑
    if (preset !== 'custom' && MAIL_PRESETS[preset]) {
      host = MAIL_PRESETS[preset].host;
      port = MAIL_PRESETS[preset].port;
    }
    var user = $('s-mail-user').value.trim();
    var patch = {
      mail: {
        enabled: $('s-mail-enabled').checked,
        host: host,
        port: port,
        user: user,
        from: user,
        to: $('s-mail-to').value.trim(),
        time: $('s-mail-time').value || '08:30'
      }
    };
    // 三态里的「不改」：留空就不传 pass，后端会保留原来的授权码
    var pass = $('s-mail-pass').value;
    if (pass) patch.mail.pass = pass;
    return patch;
  }

  $('s-mail-save').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    api('/api/notify/settings', { method: 'PUT', body: JSON.stringify(collectMailPatch()) })
      .then(function (data) {
        state.notify.settings = data.settings;
        // 重画会顺手清空授权码输入框：明文不在页面上多留一秒
        paintNotifySettings(data.settings);
        showMsg('s-mail-msg', '', false);
        toast('设置已保存');
        loadJobStatus();
      })
      .catch(function (err) { showMsg('s-mail-msg', err.message, true); })
      .then(function () { btn.disabled = false; });
  });

  $('s-mail-test').addEventListener('click', function () {
    var btn = this;
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在发…';
    showMsg('s-mail-msg', '', false);
    // SMTP 是同步等结果的，可能要几秒，按钮必须说清楚它还在干活
    api('/api/notify/test', { method: 'POST' })
      .then(function () {
        toast('发出去了，去收件箱看看（可能在垃圾箱）');
      })
      .catch(function (err) {
        // 后端的 SMTP 原始错误最有诊断价值，原样放在红框里
        showMsg('s-mail-msg', err.message, true);
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = old;
      });
  });

  $('s-kinds-save').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    var patch = {
      kinds: {
        expire: $('s-kind-expire').checked,
        lowStock: $('s-kind-lowstock').checked,
        lent: $('s-kind-lent').checked,
        idle: $('s-kind-idle').checked
      },
      expireDays: Number($('s-expire-days').value) || 0,
      idleDays: Number($('s-idle-days').value) || 365
    };
    api('/api/notify/settings', { method: 'PUT', body: JSON.stringify(patch) })
      .then(function (data) {
        state.notify.settings = data.settings;
        paintNotifySettings(data.settings);
        showMsg('s-kinds-msg', '', false);
        toast('已保存');
        // 关掉某类之后，提醒页和红点要立刻跟着变
        state.remind.data = null;
        loadReminders().catch(function () { /* 提醒页拉不到不影响设置 */ });
      })
      .catch(function (err) { showMsg('s-kinds-msg', err.message, true); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- 设置 · 备份 ---------- */

  function loadBackupStatus() {
    return api('/api/backup/status').then(function (data) {
      state.notify.backup = data.backup;
      renderBackupStatus(data.backup);
    }).catch(function (err) {
      $('s-backup-status').innerHTML = '<p class="hint">读取失败：' + esc(err.message) + '</p>';
    });
  }

  function renderBackupStatus(b) {
    if (!b) return;
    var ext = b.externalDir
      ? (b.externalWritable ? '可写 · ' + b.externalDir : '不可用 · ' + (b.externalMessage || ''))
      : '没配置';
    var rows = [
      { k: '本地备份', v: b.count + ' 份（最多留 ' + b.keepLocal + ' 份）' },
      { k: '最近一次', v: fmtTime(b.latestAt) },
      { k: '占用大小', v: fmtBytes(b.bytes) },
      { k: '外部目录', v: ext, bad: !!b.externalDir && !b.externalWritable }
    ];
    $('s-backup-status').innerHTML = rows.map(function (r) {
      return '<p class="kv-row"><span class="kv-k">' + esc(r.k) + '</span>' +
        '<span class="kv-v' + (r.bad ? ' is-bad' : '') + '">' + esc(r.v) + '</span></p>';
    }).join('');
    $('s-backup-warn').hidden = !!b.externalDir;
  }

  $('s-backup-probe').addEventListener('click', function () {
    var btn = this;
    var dir = $('s-backup-dir').value.trim();
    btn.disabled = true;
    // probe 的 ok 表示「这个目录可写」，不是「请求成功」，所以走 apiSoft
    apiSoft('/api/backup/probe', { method: 'POST', body: JSON.stringify({ dir: dir }) })
      .then(function (data) {
        var ok = !!(data && data.ok);
        var el = $('s-backup-probe-msg');
        el.hidden = false;
        el.className = 'probe-msg ' + (ok ? 'is-ok' : 'is-err');
        el.textContent = (data && data.message) || (ok ? '可写' : '这个目录写不了');
      })
      .catch(function (err) {
        var el = $('s-backup-probe-msg');
        el.hidden = false;
        el.className = 'probe-msg is-err';
        el.textContent = err.message;
      })
      .then(function () { btn.disabled = false; });
  });

  $('s-backup-run').addEventListener('click', function () {
    var btn = this;
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在备份…';
    api('/api/backup/run', { method: 'POST' })
      .then(function (data) {
        var out = data.backup || {};
        var msg = '备份好了：' + fmtBytes(out.bytes) + '（本地）';
        if (out.externalFile) msg += '，外部也复制了一份';
        if (out.externalError) msg = '本地备份好了，但外部失败：' + out.externalError;
        toast(msg);
        if (data.status) {
          state.notify.backup = data.status;
          renderBackupStatus(data.status);
        } else {
          loadBackupStatus();
        }
        loadJobStatus();
      })
      .catch(function (err) { toast(err.message); })
      .then(function () {
        btn.disabled = false;
        btn.textContent = old;
      });
  });

  /* ---------- 设置 · 运行状态 ---------- */

  function loadJobStatus() {
    return api('/api/jobs/status').then(function (data) {
      state.notify.jobs = data;
      renderJobStatus(data);
    }).catch(function (err) {
      $('s-job-list').innerHTML = '<p class="hint">读取失败：' + esc(err.message) + '</p>';
    });
  }

  function jobRow(label, job, at) {
    var st = job ? job.status : '';
    var tone = st === 'failed' ? ' is-bad' : (st === 'ok' ? ' is-ok' : '');
    return '<p class="kv-row"><span class="kv-k">' + esc(label) + '（' + esc(at) + '）</span>' +
      '<span class="kv-v' + tone + '">' + esc(JOB_STATUS_TEXT[st] || '未跑') +
      (job && job.detail ? ' · ' + esc(job.detail) : '') + '</span></p>';
  }

  function renderJobStatus(s) {
    if (!s) return;
    var jobs = s.jobs || {};
    var html = jobRow('备份', jobs.backup, s.backupTime || '03:00') +
      jobRow('摘要邮件', jobs.daily, s.mailTime || '08:30');
    if (!s.mailReady) html += '<p class="hint">邮件还没配置完整，摘要暂时发不出去。</p>';
    $('s-job-list').innerHTML = html;

    var m = s.lastMail;
    if (!m) {
      $('s-lastmail').innerHTML = '<p class="hint">还没有发过邮件</p>';
      return;
    }
    $('s-lastmail').innerHTML =
      '<p class="kv-row"><span class="kv-k">最近一封邮件</span>' +
        '<span class="kv-v">' + esc(m.subject || '（没有标题）') + '</span></p>' +
      '<p class="kv-row"><span class="kv-k">状态</span>' +
        '<span class="kv-v' + (m.status === 'failed' ? ' is-bad' : '') + '">' +
        esc(MAIL_STATUS_TEXT[m.status] || m.status) + ' · 尝试 ' + esc(m.attempts) + ' 次</span></p>' +
      '<p class="kv-row"><span class="kv-k">时间</span>' +
        '<span class="kv-v">' + esc(fmtTime(m.sentAt || m.createdAt)) + '</span></p>' +
      (m.lastError ? '<p class="kv-err">' + esc(m.lastError) + '</p>' : '');
  }

  $('s-job-run').addEventListener('click', function () {
    var btn = this;
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在发…';
    showMsg('s-job-msg', '', false);
    // 失败时后端回的是 {ok:false, detail}，用 apiSoft 才拿得到真实原因
    apiSoft('/api/jobs/run', { method: 'POST', body: JSON.stringify({ job: 'daily' }) })
      .then(function (data) {
        if (data && data.ok) toast(data.detail || '已发出去');
        else showMsg('s-job-msg', (data && data.detail) || '发送失败', true);
        loadJobStatus();
      })
      .catch(function (err) { showMsg('s-job-msg', err.message, true); })
      .then(function () {
        btn.disabled = false;
        btn.textContent = old;
      });
  });

  /* ---------- 身份与门禁 ---------- */

  function applyAuth(data) {
    state.auth = {
      me: data.me || null,
      members: data.members || [],
      caps: data.caps || {},
      roles: data.roles || [],
      needSetup: !!data.needSetup,
      bootstrap: !!data.bootstrap
    };
  }

  // 权限收口：只负责「不显示」，真正的拦截在后端
  function applyPermissions() {
    var body = document.body;
    body.classList.toggle('no-write', !can('write'));
    body.classList.toggle('no-remove', !can('remove'));
    body.classList.toggle('no-price', !can('seePrice'));

    var addTab = document.querySelector('.tab[data-tab="add"]');
    if (addTab) addTab.hidden = !can('write');

    var priceField = $('f-price-field');
    if (priceField) priceField.hidden = !can('seePrice');

    docStatsBar();

    if (!can('write') && state.tab === 'add') setTab('search');
    if (!can('stats') && state.tab === 'stats') setTab(state.prevTab || 'search');
    if (!can('settings') && state.tab === 'settings') {
      setTab(state.prevTab === 'settings' ? 'search' : (state.prevTab || 'search'));
    }
    if (!can('members')) $('mm').hidden = true;
  }

  function docStatsBar() {
    var wrap = $('stat-value-wrap');
    if (wrap) wrap.hidden = !can('seePrice');
    var bar = $('stats-bar');
    if (!bar) return;
    bar.classList.toggle('four', can('seePrice'));
    bar.classList.toggle('is-entry', can('stats'));
    bar.setAttribute('tabindex', can('stats') ? '0' : '-1');
  }

  function enterApp() {
    $('gate').hidden = true;
    state.wb.stale = true;
    applyPermissions();
    renderWho();
    renderFormSelects();
    // 换人进来后，录入默认归属新的当前身份
    if ($('f-owner')) $('f-owner').value = '';
    renderOwnerSelect();
    renderRoleOptions();
    // 红点要在开机时就出现，不能等用户点进提醒页才算
    loadReminders().catch(function () { /* 提醒拉不到不影响别的功能 */ });
    // 识别按钮的显隐由服务端决定：没配 Key 就根本不出按钮
    refreshAiStatus();
    return Promise.all([loadLocations(), doSearch(), loadStats()]).catch(function (err) {
      console.error(err);
      toast('加载失败：' + err.message);
    });
  }

  function bootAuth() {
    return api('/api/auth/me').then(function (data) {
      applyAuth(data);
      if (data.needSetup) { paintSetupGate(); return null; }
      if (!data.me) { paintMemberGate(); return null; }
      return enterApp();
    }).catch(function (err) {
      $('gate').hidden = false;
      $('gate-card').innerHTML =
        '<h2 class="gate-title">打不开家门</h2>' +
        '<p class="gate-sub">' + esc(err.message) + '</p>' +
        '<div class="gate-actions">' +
          '<button type="button" class="primary" id="gate-retry">再试一次</button>' +
        '</div>';
      var btn = $('gate-retry');
      if (btn) btn.addEventListener('click', function () { bootAuth(); });
    });
  }

  function paintSetupGate() {
    $('gate').hidden = false;
    $('gate-card').innerHTML =
      '<h2 class="gate-title">先建一个管理员</h2>' +
      '<p class="gate-sub">这东西只放在你家里，不联网。名字和密码只有你们自己知道。</p>' +
      '<form class="gate-form" id="setup-form">' +
        '<label class="field"><span class="label-text">你的名字</span>' +
          '<input id="setup-name" placeholder="比如：爸爸" autocomplete="off" /></label>' +
        '<label class="field"><span class="label-text">设个密码（至少 6 位）</span>' +
          '<input id="setup-pass" type="password" placeholder="≥6 位" autocomplete="new-password" /></label>' +
        '<div class="gate-actions">' +
          '<button type="submit" class="primary" id="setup-submit">建好，开始用</button>' +
        '</div>' +
      '</form>' +
      '<button type="button" class="gate-skip" id="gate-skip">先跳过，直接开始用</button>' +
      '<p class="gate-hint">以后可以在右上角「身份」里添加家人、改密码。</p>';

    $('setup-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('setup-name').value.trim();
      var pass = $('setup-pass').value;
      if (!name) { toast('先写个名字吧'); return; }
      if (pass.length < 6) { toast('密码至少 6 位'); return; }
      var btn = $('setup-submit');
      btn.disabled = true;
      api('/api/auth/setup', {
        method: 'POST', body: JSON.stringify({ name: name, password: pass })
      }).then(function (data) {
        return api('/api/auth/me').then(function (full) {
          applyAuth(full);
          if (data && data.recoverCode) {
            paintRecoverCode(data.recoverCode, enterApp);
          } else {
            toast('管理员建好了');
            enterApp();
          }
        });
      }).catch(function (err) {
        btn.disabled = false;
        toast(err.message);
      });
    });

    $('gate-skip').addEventListener('click', function () { enterApp(); });
  }

  // 恢复码只出现一次，必须让用户看见并确认抄下
  function paintRecoverCode(code, done) {
    $('gate').hidden = false;
    $('gate-card').innerHTML =
      '<h2 class="gate-title">抄下这串恢复码</h2>' +
      '<p class="gate-sub">忘记密码时，它是唯一能把管理员找回来的东西。' +
        '抄在路由器背面，或者抽屉里的纸条上。</p>' +
      '<div class="code-box">' + esc(code) + '</div>' +
      '<div class="gate-actions code-actions">' +
        '<button type="button" class="primary" id="code-ok">我抄好了</button>' +
      '</div>' +
      '<p class="gate-hint">这串码只显示这一次，关掉就看不到了。</p>';
    $('code-ok').addEventListener('click', function () {
      $('gate').hidden = true;
      if (done) done();
    });
  }

  function paintMemberGate() {
    $('gate').hidden = false;
    var members = state.auth.members || [];
    $('gate-card').innerHTML =
      '<h2 class="gate-title">你是谁？</h2>' +
      '<p class="gate-sub">点自己的名字进来。能不能看金额、能不能删东西，都按身份来。</p>' +
      '<div class="member-grid">' +
        members.map(function (m) {
          return '<button type="button" class="member-btn" data-mid="' + esc(m.id) + '">' +
            '<span class="mem-avatar">' + esc(String(m.name || '?').slice(0, 1)) + '</span>' +
            '<span class="member-name">' + esc(m.name) + '</span>' +
            '<span class="role-tag">' + esc(roleName(m.role)) + '</span>' +
          '</button>';
        }).join('') +
      '</div>' +
      '<p class="gate-hint">没看到自己？让管理员在「成员管理」里加一个。</p>';
  }

  $('gate-card').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-mid]') : null;
    if (!btn) return;
    var m = (state.auth.members || []).filter(function (x) { return x.id === btn.dataset.mid; })[0];
    if (!m) return;
    if (m.hasPassword) paintPasswordGate(m);
    else loginMember(m.id, null);
  });

  function paintPasswordGate(m) {
    $('gate').hidden = false;
    $('gate-card').innerHTML =
      '<button type="button" class="mini gate-back" id="pw-back">← 换个人</button>' +
      '<h2 class="gate-title">' + esc(m.name) + ' 的密码</h2>' +
      '<p class="gate-sub">输密码才能进。</p>' +
      '<form class="gate-form" id="pw-form">' +
        '<label class="field"><span class="label-text">密码</span>' +
          '<input id="pw-input" type="password" autocomplete="current-password" /></label>' +
        '<div class="gate-actions"><button type="submit" class="primary">进来</button></div>' +
        '<p class="gate-err" id="pw-err" hidden></p>' +
      '</form>';
    $('pw-back').addEventListener('click', function () { paintMemberGate(); });
    $('pw-input').focus();
    $('pw-form').addEventListener('submit', function (e) {
      e.preventDefault();
      loginMember(m.id, $('pw-input').value, $('pw-err'));
    });
  }

  function loginMember(id, password, errBox) {
    return api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ memberId: id, password: password || undefined })
    }).then(function (data) {
      // 登录接口只回 me + caps，成员名单要再取一次
      return api('/api/auth/me').then(function (full) {
        applyAuth(full);
        toast('欢迎，' + (data.me ? data.me.name : ''));
        return enterApp();
      });
    }).catch(function (err) {
      if (errBox) {
        errBox.hidden = false;
        errBox.textContent = err.message;
      }
      toast(err.message);
    });
  }

  function renderWho() {
    var btn = $('who-btn');
    if (!btn) return;
    var me = state.auth.me;
    if (!me) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.textContent = me.name;
    btn.title = '当前身份：' + me.name + '（' + roleName(me.role) + '）';
  }

  function paintWhoPanel() {
    var panel = $('who-panel');
    var me = state.auth.me;
    if (!me) return;
    var others = (state.auth.members || []).filter(function (m) { return m.id !== me.id; });
    var html = '<div class="who-head">当前身份<br><b>' + esc(me.name) + '</b> ' +
      '<span class="role-tag">' + esc(roleName(me.role)) + '</span></div>';
    if (others.length) {
      html += '<p class="who-label">切换成员</p>' + others.map(function (m) {
        return '<button type="button" class="who-item" data-switch="' + esc(m.id) + '">' +
          '<span>' + esc(m.name) + '</span>' +
          '<span class="role-tag">' + esc(roleName(m.role)) + '</span></button>';
      }).join('') + '<div class="who-sep"></div>';
    }
    if (can('members')) {
      html += '<button type="button" class="who-item" data-who="manage">成员管理</button>';
    }
    if (can('settings')) {
      html += '<button type="button" class="who-item" data-who="settings">设置</button>';
    }
    html += '<button type="button" class="who-item danger" data-who="logout">退出登录</button>';
    panel.innerHTML = html;
    panel.hidden = false;
  }

  $('who-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    var panel = $('who-panel');
    if (!panel.hidden) { panel.hidden = true; return; }
    paintWhoPanel();
  });

  $('who-panel').addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-switch],[data-who]') : null;
    if (!t) return;
    if (t.dataset.switch) {
      var m = (state.auth.members || []).filter(function (x) { return x.id === t.dataset.switch; })[0];
      $('who-panel').hidden = true;
      if (!m) return;
      if (m.hasPassword) paintPasswordGate(m);
      else loginMember(m.id, null);
      return;
    }
    var act = t.dataset.who;
    $('who-panel').hidden = true;
    if (act === 'logout') logout();
    if (act === 'manage') openMembers();
    if (act === 'settings') openSettings();
  });

  document.addEventListener('click', function (e) {
    var panel = $('who-panel');
    if (panel.hidden) return;
    if (e.target.closest && e.target.closest('#who-panel')) return;
    if (e.target.closest && e.target.closest('#who-btn')) return;
    panel.hidden = true;
  });

  function logout() {
    api('/api/auth/logout', { method: 'POST' }).then(function () {
      return api('/api/auth/me').then(function (data) {
        applyAuth(data);
        state.tab = 'search';
        setTab('search');
        $('who-btn').hidden = true;
        if (data.needSetup) paintSetupGate();
        else paintMemberGate();
      });
    }).catch(function (err) { toast(err.message); });
  }

  /* ---------- 成员管理（仅管理员） ---------- */

  function renderRoleOptions() {
    var sel = $('mm-role');
    if (!sel) return;
    sel.innerHTML = (state.auth.roles || []).map(function (r) {
      return '<option value="' + esc(r.k) + '">' + esc(r.n) + '</option>';
    }).join('');
    // 加人默认给「成员」，管理员要显式选
    sel.value = 'member';
  }

  function openMembers() {
    if (!can('members')) return;
    renderRoleOptions();
    $('mm').hidden = false;
    loadMembers();
  }

  function refreshAuth() {
    return api('/api/auth/me').then(function (data) {
      applyAuth(data);
      if (!data.me) {
        $('mm').hidden = true;
        paintMemberGate();
        return;
      }
      applyPermissions();
      renderWho();
      renderRoleOptions();
      renderOwnerSelect();
    }).catch(function (err) { toast(err.message); });
  }

  // 成员一改，自己的 role / 会话版本可能就变了：先刷新身份，再重画列表
  function afterMemberChange() {
    return refreshAuth().then(function () {
      if (can('members')) paintMemberRows();
    });
  }

  function loadMembers() {
    return api('/api/members').then(function (data) {
      state.auth.members = data.members || [];
      if (state.auth.me) {
        var mine = state.auth.members.filter(function (m) { return m.id === state.auth.me.id; })[0];
        if (mine) { state.auth.me.name = mine.name; state.auth.me.role = mine.role; }
      }
      paintMemberRows();
      renderWho();
      renderOwnerSelect();
      // 衣柜的归属 chip 与卡片上的名字都依赖成员名单
      if (state.wb.loaded) { renderChips(); renderGarments(); }
      return data.members;
    }).catch(function (err) { toast(err.message); });
  }

  function paintMemberRows() {
    var me = state.auth.me;
    var roles = state.auth.roles || [];
    var html = (state.auth.members || []).map(function (m) {
      var opts = roles.map(function (r) {
        return '<option value="' + esc(r.k) + '"' + (r.k === m.role ? ' selected' : '') + '>' +
          esc(r.n) + '</option>';
      }).join('');
      var self = me && m.id === me.id;
      return '<div class="mm-row" data-mid="' + esc(m.id) + '">' +
        '<div class="mm-line">' +
          '<input class="mm-name" value="' + esc(m.name) + '" aria-label="成员名字" />' +
          '<select class="mm-role-sel" aria-label="成员角色">' + opts + '</select>' +
        '</div>' +
        '<div class="mm-line mm-actions">' +
          '<button type="button" class="mini" data-mact="save">保存</button>' +
          '<button type="button" class="mini" data-mact="pass">设密码</button>' +
          (self ? '' : '<button type="button" class="mini danger" data-mact="del">删除</button>') +
          '<span class="role-tag">' + (m.hasPassword ? '有密码' : '免密') + '</span>' +
        '</div>' +
        '<div class="mm-pass-row" hidden>' +
          '<input type="password" class="mm-pass" placeholder="新密码，至少 6 位" ' +
            'autocomplete="new-password" />' +
          '<button type="button" class="mini" data-mact="passgo">确定</button>' +
        '</div>' +
      '</div>';
    }).join('');
    $('mm-list').innerHTML = html || '<p class="hint">还没有成员</p>';
  }

  $('mm-list').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-mact]') : null;
    if (!btn) return;
    var row = btn.closest('.mm-row');
    if (!row) return;
    var id = row.dataset.mid;
    var m = (state.auth.members || []).filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    var act = btn.dataset.mact;

    if (act === 'pass') {
      var pr = row.querySelector('.mm-pass-row');
      pr.hidden = !pr.hidden;
      if (!pr.hidden) pr.querySelector('.mm-pass').focus();
      return;
    }

    if (act === 'save') {
      var name = row.querySelector('.mm-name').value.trim();
      var role = row.querySelector('.mm-role-sel').value;
      if (!name) { toast('名字不能为空'); return; }
      api('/api/members/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify({ name: name, role: role })
      }).then(function (data) {
        toast('已保存：' + data.member.name);
        return afterMemberChange();
      }).catch(function (err) { toast(err.message); });
      return;
    }

    if (act === 'passgo') {
      var pass = row.querySelector('.mm-pass').value;
      if (pass.length < 6) { toast('密码至少 6 位'); return; }
      api('/api/members/' + encodeURIComponent(id) + '/password', {
        method: 'POST', body: JSON.stringify({ password: pass })
      }).then(function (data) {
        if (data.recoverCode) {
          // 改自己的密码会立刻作废旧会话，等用户抄完码再刷新身份
          paintRecoverCode(data.recoverCode, afterMemberChange);
        } else {
          toast('密码已更新');
          afterMemberChange();
        }
      }).catch(function (err) { toast(err.message); });
      return;
    }

    if (act === 'del') {
      if (!window.confirm('删除成员「' + m.name + '」？\n他记的东西不会删，归属会变成共用')) return;
      api('/api/members/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
        toast('已删除：' + m.name);
        return afterMemberChange();
      }).catch(function (err) { toast(err.message); });
    }
  });

  $('mm-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('mm-name').value.trim();
    var role = $('mm-role').value;
    var pass = $('mm-pass').value;
    if (!name) { toast('先写个名字'); return; }
    if (pass && pass.length < 6) { toast('密码至少 6 位，或者不填'); return; }
    var body = { name: name, role: role };
    if (pass) body.password = pass;
    api('/api/members', { method: 'POST', body: JSON.stringify(body) }).then(function (data) {
      $('mm-name').value = '';
      $('mm-pass').value = '';
      toast('已添加：' + data.member.name);
      if (data.recoverCode) {
        paintRecoverCode(data.recoverCode, afterMemberChange);
      } else {
        afterMemberChange();
      }
    }).catch(function (err) { toast(err.message); });
  });

  $('mm-close').addEventListener('click', function () { $('mm').hidden = true; });
  $('mm').addEventListener('click', function (e) {
    if (e.target === this) $('mm').hidden = true;
  });

  /* ---------- 离线缓存 ---------- */

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function (reg) {
          // 每次打开都主动查一次有没有新版本，避免页面长期开着停在旧代码上
          if (reg && reg.update) reg.update();
        }).catch(function () { /* 忽略 */ });
      });
    }

  /* ---------- 启动 ---------- */

  // 页面上显示版本号，方便判断浏览器是不是还拿着旧代码
  (function () {
    var box = $('app-ver');
    if (box) box.textContent = '前端资源 ' + APP_VERSION;
  })();

  // 先确定「我是谁」，再加载任何数据；没身份就停在门禁层
  bootAuth();
})();
