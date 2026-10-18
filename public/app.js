'use strict';

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var VB = { w: 100, h: 88 };

  // 必须与 index.html 里 style.css / app.js 的 ?v= 保持一致。
  // 页面底部会把它显示出来，一眼就能确认浏览器拿到的是不是最新代码。
  var APP_VERSION = 'v7';

  var state = {
    tab: 'search',
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
    wb: {
      loaded: false,
      stale: true,
      items: [],
      dict: null,
      facets: null,
      season: '',
      pickedSeason: '',
      filters: { type: '', season: '', color: '', status: '' },
      editingId: null
    }
  };

  /* ---------- 工具 ---------- */

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

  function api(url, options) {
    return fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}))
      .then(function (res) {
        return res.json().catch(function () { throw new Error('服务端返回异常'); });
      })
      .then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.error) || '操作失败');
        return data;
      });
  }

  function node(id) { return state.byId[id]; }

  /* ---------- 照片 ----------
     手机直出的照片动辄三四千像素、好几 MB。家里虽然传得快，
     但香橙派的 TF 卡写入慢、空间也有限，所以先在浏览器里压成
     长边 1280 的 JPEG，通常能压到原来的十分之一以下，肉眼看不出差别。 */

  var PHOTO_MAX_SIDE = 1280;

  function compressImage(file) {
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
            var scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(sw, sh));
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
          '<div class="result-actions">' +
            '<button type="button" class="mini" data-act="edit" data-id="' + esc(item.id) + '">编辑</button>' +
            '<button type="button" class="mini danger" data-act="del" data-id="' + esc(item.id) + '">删除</button>' +
          '</div>' +
        '</div>' +
      '</article>';
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
  }

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
        kind: n.kind, box: n.box, itemCount: n.itemCount, totalCount: n.totalCount
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
    return loadItems('').then(function (all) {
      var box = target || $('loc-items');
      var ids = collectSubtree(id);
      var list = all.filter(function (i) { return ids.indexOf(i.locId) !== -1; });
      if (!list.length) {
        box.innerHTML = '<p class="loc-title">' + esc(name) + '</p>' +
          '<p class="empty">这里还是空的</p>';
        return;
      }
      box.innerHTML = '<p class="loc-title">' + esc(name) + ' · ' + list.length + ' 件</p>';
      renderItems(box, list, '');
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
  }

  // 连续录入时位置要留着，但照片必须清掉，
  // 否则上一件的照片会被挂到下一件东西上
  function clearBodyKeepLocation() {
    itemPhotos.reset(null);
    $('f-name').value = '';
    $('f-note').value = '';
    $('f-qty').value = '1';
    $('f-tags').value = '';
  }

  function startEdit(id) {
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
    itemPhotos.reset(item.photo);
    setTab('add');
    $('f-name').focus();
  }

  function removeItem(id) {
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

  $('item-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var payload = {
      name: $('f-name').value.trim(),
      locId: $('f-loc').value || null,
      qty: Number($('f-qty').value) || 1,
      tags: $('f-tags').value,
      note: $('f-note').value.trim()
    };
    if (!payload.name) { toast('总得有个名字吧'); return; }

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
          return doSearch();
        }
        toast('记下了：' + payload.name + '（位置保留着，接着录下一件）');
        clearBodyKeepLocation();
        $('f-name').focus();
        return Promise.all([loadLocations(), loadItems('')]).then(function () {
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
    return api('/api/wardrobe/suggest?season=' + encodeURIComponent(state.wb.pickedSeason))
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

  ['chip-type', 'chip-season', 'chip-color', 'chip-status'].forEach(function (id) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.chip') : null;
      if (!b) return;
      state.wb.filters[b.dataset.dim] = b.dataset.val;
      renderChips();
      renderGarments();
    });
  });

  $('clear-filter').addEventListener('click', function () {
    state.wb.filters = { type: '', season: '', color: '', status: '' };
    renderChips();
    renderGarments();
  });

  function filteredGarments() {
    var f = state.wb.filters;
    return state.wb.items.filter(function (i) {
      var w = i.wear;
      if (f.type && w.type !== f.type) return false;
      if (f.season && (w.seasons || []).indexOf(f.season) === -1) return false;
      if (f.color && (w.colors || []).indexOf(f.color) === -1) return false;
      if (f.status && w.status !== f.status) return false;
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
    var occasions = (w.occasions && w.occasions.length) ? ' · ' + w.occasions.join('/') : '';
    // 有照片就用照片，没照片才退回到色块
    var media = g.photo
      ? '<img class="gsw is-photo" src="' + esc(photoUrl(g.photo)) + '" loading="lazy"' +
        ' alt="' + esc(g.name) + '" data-full="' + esc(photoUrl(g.photo)) + '" />'
      : '<span class="gsw" style="' + swatchCss(w.colors) + '"></span>';
    return '<article class="gcard">' +
      media +
      '<span class="gbody">' +
        '<span class="gtop"><span class="gname">' + esc(g.name) + '</span>' + badge + '</span>' +
        '<span class="gmeta">' + esc(meta) + '</span>' +
        '<span class="gpath">' + esc(g.path) + '</span>' +
        '<span class="gfoot">' + esc(wornText(w)) + ' · 共 ' + (w.wearCount || 0) + ' 次' +
          esc(occasions) + '</span>' +
      '</span>' +
      '<span class="gacts">' +
        '<button type="button" class="mini" data-act="wore" data-id="' + esc(g.id) + '">今天穿了</button>' +
        '<button type="button" class="mini" data-act="gedit" data-id="' + esc(g.id) + '">编辑</button>' +
        '<button type="button" class="mini danger" data-act="gdel" data-id="' + esc(g.id) + '">删除</button>' +
      '</span>' +
    '</article>';
  }

  function renderGarments() {
    var box = $('garments');
    if (!state.wb.items.length) {
      box.innerHTML = '<div class="empty-box">' +
        '<p class="empty">衣柜还是空的</p>' +
        '<button id="load-demo" class="mini">放几件示例衣服进来看看效果</button>' +
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
    api('/api/items/' + encodeURIComponent(id) + '/wear', {
      method: 'POST', body: JSON.stringify({ laundry: true })
    }).then(function () {
      toast('记下了，已移到待洗');
      state.wb.stale = true;
      return Promise.all([loadWardrobe(), doSearch()]);
    }).catch(function (err) { toast(err.message); });
  }

  function removeGarment(id) {
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

  Promise.all([loadLocations(), doSearch()]).catch(function (err) {
    console.error(err);
    toast('加载失败：' + err.message);
  });
})();
