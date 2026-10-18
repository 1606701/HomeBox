'use strict';

// HomeBox 家庭收纳服务端
// 零依赖：只使用 Node 内置模块，无需 npm install
//   node server.js                    本机预览 http://127.0.0.1:8080
//   HOST=0.0.0.0 node server.js       部署到香橙派，局域网内可访问
//   PORT=3000 node server.js          换个端口

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MAX_BODY = 2 * 1024 * 1024;
// 照片走 base64，体积会膨胀约三分之一，所以单独放宽上限
const MAX_PHOTO_BODY = 9 * 1024 * 1024;
// 单张图片的最终体积上限，防止有人直接塞一张原图进来把 TF 卡写满
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

/* ---------- 衣物属性（衣柜模块） ----------
   衣物不单独建表，而是复用 items，额外挂一个可选的 wear 字段。
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

function daysSince(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

let counter = 0;
function genId(prefix) {
  counter += 1;
  return prefix + '_' + Date.now().toString(36) + counter.toString(36) +
    Math.random().toString(36).slice(2, 6);
}

// 两个矩形是否有重叠
function overlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}

const PLAN_W = 100;
const PLAN_H = 88;

function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

// 新房间：细网格扫描找空位，尺寸逐级缩小；始终保证落在画布内
function autoRoomBox(db) {
  const rooms = db.locations.filter((l) => l.kind === 'room' && l.box);
  const sizes = [[28, 22], [24, 18], [20, 15], [16, 12]];
  for (let s = 0; s < sizes.length; s += 1) {
    const w = sizes[s][0];
    const h = sizes[s][1];
    for (let y = 1; y + h <= PLAN_H - 1; y += 2) {
      for (let x = 1; x + w <= PLAN_W - 1; x += 2) {
        const box = { x, y, w, h };
        if (!rooms.some((l) => overlaps(box, l.box))) return box;
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
      const area = rooms.reduce((sum, l) => sum + overlapArea(box, l.box), 0);
      if (area < bestArea) { bestArea = area; best = box; }
    }
  }
  return best;
}

// 新家具：落在父房间内，避开同屋其他家具
function autoFurnitureBox(db, parentId) {
  const parent = db.locations.find((l) => l.id === parentId);
  const base = parent && parent.box ? parent.box : { x: 4, y: 4, w: 30, h: 24 };
  const fw = Math.max(6, Math.min(14, base.w * 0.32));
  const fh = Math.max(5, Math.min(11, base.h * 0.22));
  const sibs = db.locations.filter((l) => l.parent === parentId && l.box);
  const cols = Math.max(2, Math.floor((base.w - 2) / (fw + 1.2)));
  for (let i = 0; i < 24; i += 1) {
    const box = {
      x: base.x + 1.5 + (i % cols) * (fw + 1.2),
      y: base.y + 5 + Math.floor(i / cols) * (fh + 1.2),
      w: fw, h: fh
    };
    if (box.y + box.h > base.y + base.h - 0.5) break;
    if (!sibs.some((l) => overlaps(box, l.box))) return box;
  }
  // 房间塞满了：贴着房间左上角放，并保证不出画布
  return {
    x: Math.min(base.x + 1.5, PLAN_W - fw - 0.5),
    y: Math.min(base.y + 5, PLAN_H - fh - 0.5),
    w: fw, h: fh
  };
}

// 防环：nodeId 是否是 ancestorId 的后代
function isDescendant(db, ancestorId, nodeId) {
  let cur = db.locations.find((l) => l.id === nodeId);
  let guard = 0;
  while (cur && guard < 64) {
    if (cur.parent === ancestorId) return true;
    cur = cur.parent ? db.locations.find((l) => l.id === cur.parent) : null;
    guard += 1;
  }
  return false;
}

function nowISO() {
  return new Date().toISOString();
}

/* ---------- 照片 ----------
   图片以独立文件存在 data/photos 下，db.json 里只留文件名。
   好处：数据文件不会被几千张图片撑大到读不动，备份时也好分别处理。 */

// 不看客户端给的后缀，直接读文件头判断，避免有人拿 .jpg 的名字传别的东西上来
function sniffImage(buf) {
  if (buf.length < 12) throw new Error('图片内容不完整');
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  throw new Error('不支持的图片格式，请用 jpg / png / webp');
}

// 文件名只允许这一个形状，杜绝 ../ 之类的路径穿越
var PHOTO_NAME_RE = /^[a-zA-Z0-9_-]{1,40}\.(jpg|png|webp)$/;

function writePhotoFile(base64) {
  if (typeof base64 !== 'string' || !base64.length) throw new Error('没有收到图片内容');
  // 允许前端直接把整个 dataURL 传过来
  var pure = base64.indexOf('base64,') !== -1 ? base64.split('base64,')[1] : base64;
  if (!/^[A-Za-z0-9+/=]+$/.test(pure)) throw new Error('图片编码格式不对');
  var buf = Buffer.from(pure, 'base64');
  if (!buf.length) throw new Error('图片内容是空的');
  if (buf.length > MAX_PHOTO_BYTES) throw new Error('图片超过 6MB，请在手机上重拍一张小的');
  var ext = sniffImage(buf);
  var file = genId('p') + '.' + ext;
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  // 图片不是关键数据，写坏一张大不了重新拍，没必要走临时文件那套
  fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
  return { file: file, bytes: buf.length, ext: ext };
}

function deletePhotoFile(file) {
  if (!file || typeof file !== 'string') return;
  if (!PHOTO_NAME_RE.test(file)) return;
  try {
    fs.unlinkSync(path.join(PHOTO_DIR, file));
  } catch (err) {
    // 文件本来就不存在也算删成功了
  }
}

function servePhoto(res, pathname) {
  var raw = pathname;
  try { raw = decodeURIComponent(pathname); } catch (err) { /* 用原值 */ }
  var name = path.basename(raw);
  if (!PHOTO_NAME_RE.test(name)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400');
  }
  var full = path.join(PHOTO_DIR, name);
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    // 文件名即内容哈希级别的唯一 id，不会重名，可以放心长期缓存
    res.writeHead(200, {
      'Content-Type': 'image/' + (path.extname(name) === '.png' ? 'png'
        : (path.extname(name) === '.webp' ? 'webp' : 'jpeg')),
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    res.end(data);
  });
}

// 示例衣物清单：首次安装时写入 seed，已存在的数据库则通过 demo 接口按需导入
// slot 只说明"习惯放哪"，导入时会按用户实际的位置结构柔性匹配
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

function wearToItem(spec, locId, t) {
  return {
    id: genId('i'), name: spec.name, locId,
    note: spec.note || '', qty: 1, tags: [],
    wear: {
      type: spec.type, seasons: spec.seasons || [], colors: spec.colors || [],
      occasions: spec.occasions || [], size: spec.size || '',
      status: spec.status || 'ready', wearCount: 0, lastWorn: null
    },
    createdAt: t, updatedAt: t
  };
}

// 首次运行时写入一份真实感示例数据，打开就能用
function seed() {
  const t = nowISO();
  // box 为统一平面坐标（0 到 100），房间与家具共用一套坐标系
  // 格口（抽屉、隔板）不画在地图上，只在家具内部视图里出现
  const loc = (id, name, parent, kind, box) => ({
    id, name, parent, kind, box: box || null, createdAt: t
  });
  const it = (name, locId, note, qty, tags) => ({
    id: genId('i'), name, locId, note: note || '', qty: qty == null ? 1 : qty,
    tags: tags || [], createdAt: t, updatedAt: t
  });

  const locs = [
    loc('l_home', '我家', null, 'home'),

    loc('l_living', '客厅', 'l_home', 'room', { x: 4, y: 4, w: 44, h: 44 }),
    loc('l_tvcab', '电视柜', 'l_living', 'furniture', { x: 10, y: 13, w: 24, h: 9 }),
    loc('l_tvdrawer', '左侧抽屉', 'l_tvcab', 'compartment'),
    loc('l_sidetable', '沙发边几', 'l_living', 'furniture', { x: 8, y: 34, w: 14, h: 11 }),

    loc('l_kitchen', '厨房', 'l_home', 'room', { x: 52, y: 4, w: 44, h: 26 }),
    loc('l_lowerCab', '橱柜下层', 'l_kitchen', 'furniture', { x: 58, y: 11, w: 20, h: 9 }),
    loc('l_pantry', '储物架第二层', 'l_kitchen', 'compartment'),

    loc('l_bedroom', '卧室', 'l_home', 'room', { x: 52, y: 34, w: 44, h: 32 }),
    loc('l_nightstand', '床头柜', 'l_bedroom', 'furniture', { x: 58, y: 41, w: 13, h: 11 }),
    loc('l_wardrobe', '衣柜', 'l_bedroom', 'furniture', { x: 80, y: 41, w: 13, h: 17 }),
    loc('l_wrHanging', '挂衣区', 'l_wardrobe', 'compartment'),
    loc('l_wrFold', '叠放区', 'l_wardrobe', 'compartment'),
    loc('l_wrDrawer', '内衣抽屉', 'l_wardrobe', 'compartment'),
    loc('l_wardrobeTop', '顶层隔板', 'l_wardrobe', 'compartment'),

    loc('l_entry', '玄关', 'l_home', 'room', { x: 4, y: 52, w: 24, h: 30 }),
    loc('l_shoecab', '鞋柜抽屉', 'l_entry', 'furniture', { x: 8, y: 62, w: 16, h: 11 }),

    loc('l_bath', '卫生间', 'l_home', 'room', { x: 32, y: 52, w: 17, h: 30 }),
    loc('l_mirrorCab', '镜柜', 'l_bath', 'furniture', { x: 36, y: 60, w: 9, h: 11 })
  ];

  const items = [
    it('指甲刀', 'l_tvdrawer', '和挖耳勺放一起', 1, ['工具']),
    it('5 号电池', 'l_tvdrawer', '备用，4 节装', 4, ['耗材']),
    it('电视遥控器备用', 'l_tvdrawer', '', 1, []),
    it('Type-C 充电线', 'l_sidetable', '短的那根', 2, ['线材']),
    it('垃圾袋 备用卷', 'l_lowerCab', '', 3, ['耗材']),
    it('备用洗洁精', 'l_lowerCab', '', 1, []),
    it('干货 木耳', 'l_pantry', '注意防潮', 1, ['食品']),
    it('手电筒', 'l_nightstand', '停电时用', 1, ['应急']),
    it('换季被子', 'l_wardrobeTop', '真空袋装好', 2, ['换季']),
    it('备用钥匙', 'l_shoecab', '', 1, ['重要']),
    it('创可贴', 'l_mirrorCab', '', 1, ['药品']),
    it('感冒药', 'l_mirrorCab', '看有效期', 1, ['药品'])
  ];

  const wearSlot = {
    hanging: 'l_wrHanging', fold: 'l_wrFold', drawer: 'l_wrDrawer',
    shoes: 'l_shoecab', 'top-shelf': 'l_wardrobeTop', laundry: 'l_wrDrawer'
  };
  const wearItems = demoWearSpec().map(function (spec) {
    const locId = wearSlot[spec.slot] ||
      (spec.status === 'stored' ? 'l_wardrobeTop' : 'l_wrHanging');
    return wearToItem(spec, locId, t);
  });

  return {
    version: 2,
    // 家的宽度（米）：只用于把抽象坐标换算成真实面积，改户型时随手可调
    settings: { planWidthM: 12 },
    locations: locs,
    items: items.concat(wearItems)
  };
}

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    writeDBRaw(seed());
    return;
  }
  // 早期版本的数据没有平面坐标，从示例布局里把已知 id 的坐标补齐，
  // 这样老数据也能直接出现在家的地图上，且不会动到已录入的物品
  let db = null;
  try { db = readDB(); } catch (err) { return; }
  const boxMap = {};
  seed().locations.forEach((l) => { if (l.box) boxMap[l.id] = l.box; });
  let changed = false;
  db.locations.forEach((l) => {
    if (!l.box && boxMap[l.id]) { l.box = boxMap[l.id]; changed = true; }
  });
  if (changed) {
    writeDBRaw(db);
    console.log('[info] 已为 ' + db.locations.length + ' 个位置补上地图坐标');
  }
}

function readDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const db = JSON.parse(raw);
    if (!Array.isArray(db.locations)) db.locations = [];
    if (!Array.isArray(db.items)) db.items = [];
    if (!db.settings || typeof db.settings !== 'object') db.settings = { planWidthM: 12 };
    if (!(Number(db.settings.planWidthM) > 0)) db.settings.planWidthM = 12;
    return db;
  } catch (err) {
    console.error('[warn] 数据文件损坏，已重建：', err.message);
    return seed();
  }
}

// 原子写入：先写临时文件再改名，避免写一半掉电导致数据全损
function writeDBRaw(db) {
  const tmp = DB_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function writeDB(db) {
  writeDBRaw(db);
}

function locationPath(db, locId) {
  if (!locId) return '未归档';
  const map = new Map(db.locations.map((l) => [l.id, l]));
  const parts = [];
  let cur = map.get(locId);
  let guard = 0;
  while (cur && guard < 32) {
    parts.unshift(cur.name);
    cur = cur.parent ? map.get(cur.parent) : null;
    guard += 1;
  }
  return parts.length ? parts.join(' › ') : '未归档';
}

function buildTree(db) {
  const nodes = new Map();
  for (const l of db.locations) {
    nodes.set(l.id, {
      id: l.id, name: l.name, kind: l.kind, parent: l.parent,
      box: l.box || null, children: []
    });
  }
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parent ? nodes.get(node.parent) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const countItems = db.items.reduce((acc, item) => {
    acc[item.locId] = (acc[item.locId] || 0) + 1;
    return acc;
  }, {});
  const decorate = (node) => {
    node.itemCount = countItems[node.id] || 0;
    node.children.forEach(decorate);
    // totalCount 把子位置也算进来，地图上看到的是这一处的合计持有量
    node.totalCount = node.itemCount + node.children.reduce((s, c) => s + (c.totalCount || 0), 0);
    return node;
  };
  return roots.map(decorate);
}

function withPath(db, item) {
  return Object.assign({}, item, { path: locationPath(db, item.locId) });
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, maxSize) {
  const limit = maxSize || MAX_BODY;
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      // 超限后不能直接 destroy 连接——那样响应根本发不回去，
      // 前端只会看到一句莫名其妙的 Failed to fetch。
      // 正确做法是把多余的数据读完丢掉，照常返回一个说得清的错误。
      if (tooBig) return;
      size += chunk.length;
      if (size > limit) { tooBig = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        const err = new Error(limit > MAX_BODY
          ? '这张图太大了，重新拍一张小的，或者从相册里选压缩过的版本'
          : '内容太大了');
        err.statusCode = 413;
        return reject(err);
      }
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

// 有 Content-Length 时先拦一道，省得把几 MB 无用数据读进来再丢
function tooLarge(req, pathname) {
  const declared = Number(req.headers['content-length']);
  if (!Number.isFinite(declared)) return false;
  const limit = /\/photo$/.test(pathname) ? MAX_PHOTO_BODY : MAX_BODY;
  return declared > limit;
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

async function handleApi(req, res, pathname, query) {
  // 上传超限要在读请求体之前就判掉，否则白白收一大堆数据
  if ((req.method === 'POST' || req.method === 'PUT') && tooLarge(req, pathname)) {
    req.resume();
    const big = /\/photo$/.test(pathname);
    return sendJSON(res, 413, {
      ok: false, error: big
        ? '这张图太大了，重新拍一张小的，或者从相册里选压缩过的版本'
        : '提交的内容太长了'
    });
  }

  const db = readDB();

  if (pathname === '/api/locations') {
    if (req.method === 'GET') {
      return sendJSON(res, 200, {
        ok: true, tree: buildTree(db), settings: db.settings
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return sendJSON(res, 400, { ok: false, error: '位置名称不能为空' });
      const KINDS = ['home', 'room', 'furniture', 'compartment'];
      const kind = KINDS.indexOf(body.kind) !== -1
        ? body.kind
        : (body.parent ? 'compartment' : 'home');
      // 新建就给一个可见的位置，免得用户以为没建成
      let box = body.box || null;
      if (!box) {
        if (kind === 'room') box = autoRoomBox(db);
        else if (kind === 'furniture') box = autoFurnitureBox(db, body.parent || null);
      }
      const location = {
        id: genId('l'), name, parent: body.parent || null,
        kind, box, createdAt: nowISO()
      };
      db.locations.push(location);
      writeDB(db);
      return sendJSON(res, 201, { ok: true, location });
    }
  }

  if (pathname.startsWith('/api/locations/')) {
    const id = decodeURIComponent(pathname.slice('/api/locations/'.length));
    const idx = db.locations.findIndex((l) => l.id === id);
    if (idx === -1) return sendJSON(res, 404, { ok: false, error: '位置不存在' });

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const cur = db.locations[idx];
      if (body.name !== undefined) cur.name = String(body.name).trim() || cur.name;
      if (body.box !== undefined) cur.box = body.box;
      if (body.parent !== undefined) {
        const next = body.parent || null;
        if (next === cur.id) {
          return sendJSON(res, 400, { ok: false, error: '不能挂到自己下面' });
        }
        // 把自己的某个上级挪到自己下面会让整棵树断掉
        if (next && isDescendant(db, cur.id, next)) {
          return sendJSON(res, 400, { ok: false, error: '不能挂到自己的下级里' });
        }
        if (next && !db.locations.find((l) => l.id === next)) {
          return sendJSON(res, 404, { ok: false, error: '上级位置不存在' });
        }
        cur.parent = next;
      }
      if (body.kind !== undefined
        && ['home', 'room', 'furniture', 'compartment'].indexOf(body.kind) !== -1) {
        cur.kind = body.kind;
      }
      writeDB(db);
      return sendJSON(res, 200, { ok: true, location: cur });
    }

    if (req.method === 'DELETE') {
      // 连同子孙位置一起删除，其中的物品保留下来，只是标记为未归档
      const doomed = new Set();
      const walk = (target) => {
        doomed.add(target);
        db.locations.filter((l) => l.parent === target).forEach((c) => walk(c.id));
      };
      walk(id);
      db.locations = db.locations.filter((l) => !doomed.has(l.id));
      db.items.forEach((item) => {
        if (doomed.has(item.locId)) item.locId = null;
      });
      writeDB(db);
      return sendJSON(res, 200, { ok: true, removed: doomed.size });
    }
  }

  // 户型设置：家的真实宽度（米），只用于把抽象坐标换算成面积显示
  if (pathname === '/api/settings' && req.method === 'PUT') {
    const body = await readBody(req);
    const m = Number(body.planWidthM);
    if (!(m > 0) || m > 200) {
      return sendJSON(res, 400, { ok: false, error: '宽度要填一个正数（米）' });
    }
    db.settings.planWidthM = Math.round(m * 10) / 10;
    writeDB(db);
    return sendJSON(res, 200, { ok: true, settings: db.settings });
  }

  if (pathname === '/api/items') {
    if (req.method === 'GET') {
      const q = String(query.get('q') || '').trim().toLowerCase();
      let list = db.items.map((item) => withPath(db, item));
      if (q) {
        list = list.filter((item) => {
          const hay = [item.name, item.note, (item.tags || []).join(' '), item.path]
            .join(' ').toLowerCase();
          return hay.includes(q);
        });
      }
      // 搜索结果优先展示最近更新
      list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return sendJSON(res, 200, { ok: true, items: list });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return sendJSON(res, 400, { ok: false, error: '物品名称不能为空' });
      const t = nowISO();
      const rawTags = body.tags || [];
      const tags = Array.isArray(rawTags)
        ? rawTags.map((x) => String(x).trim()).filter(Boolean)
        : String(rawTags).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      const item = {
        id: genId('i'), name,
        locId: body.locId || null,
        note: String(body.note || ''),
        qty: Number.isFinite(Number(body.qty)) && Number(body.qty) > 0 ? Number(body.qty) : 1,
        tags, createdAt: t, updatedAt: t
      };
      // 带 wear 字段的就是一件衣服，会同时出现在衣柜模块里
      const wear = sanitizeWear(body.wear);
      if (wear) item.wear = wear;
      db.items.push(item);
      writeDB(db);
      return sendJSON(res, 201, { ok: true, item: withPath(db, item) });
    }
  }

  /* ---------- 照片 ---------- */

  // 注意要排在 /api/items/:id 前面，否则 id 会被正则吃成 "xxx/photo"
  const photoMatch = pathname.match(/^\/api\/items\/(.+)\/photo$/);
  if (photoMatch) {
    const id = decodeURIComponent(photoMatch[1]);
    const item = db.items.find((x) => x.id === id);
    if (!item) return sendJSON(res, 404, { ok: false, error: '物品不存在' });

    if (req.method === 'POST') {
      const body = await readBody(req, MAX_PHOTO_BODY);
      let saved;
      try {
        saved = writePhotoFile(body.data);
      } catch (err) {
        return sendJSON(res, 400, { ok: false, error: err.message });
      }
      // 换新照片就把旧的删掉，别让 TF 卡白占地方
      const oldFile = item.photo;
      item.photo = saved.file;
      item.updatedAt = nowISO();
      writeDB(db);
      if (oldFile && oldFile !== saved.file) deletePhotoFile(oldFile);
      return sendJSON(res, 200, { ok: true, item: withPath(db, item), photo: saved });
    }

    if (req.method === 'DELETE') {
      deletePhotoFile(item.photo);
      delete item.photo;
      item.updatedAt = nowISO();
      writeDB(db);
      return sendJSON(res, 200, { ok: true, item: withPath(db, item) });
    }
  }

  /* ---------- 衣柜模块 ---------- */

  // 记录「今天穿了」：累计次数、更新最近穿着日期，穿过的默认转为待洗
  const wearLog = pathname.match(/^\/api\/items\/(.+)\/wear$/);
  if (wearLog && req.method === 'POST') {
    const id = decodeURIComponent(wearLog[1]);
    const item = db.items.find((x) => x.id === id);
    if (!item) return sendJSON(res, 404, { ok: false, error: '找不到这件东西' });
    if (!item.wear) return sendJSON(res, 400, { ok: false, error: '它不是衣服' });
    const body = await readBody(req);
    const prior = item.wear.wearCount || 0;
    const priorWorn = item.wear.lastWorn || null;
    if (body.undo) {
      item.wear.wearCount = Math.max(0, prior - 1);
      item.wear.lastWorn = null;
    } else {
      item.wear.wearCount = prior + 1;
      item.wear.lastWorn = nowISO();
      if (body.laundry !== false) item.wear.status = 'laundry';
    }
    item.updatedAt = nowISO();
    writeDB(db);
    return sendJSON(res, 200, {
      ok: true, item: withPath(db, item), restored: { wearCount: prior, lastWorn: priorWorn }
    });
  }

  if (pathname === '/api/wardrobe' && req.method === 'GET') {
    const list = db.items
      .filter((i) => i.wear)
      .map((i) => withPath(db, i))
      .map((i) => Object.assign({}, i, {
        wear: Object.assign({}, i.wear, { idleDays: daysSince(i.wear.lastWorn) })
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    //  facets：给前端的筛选 chips 提供每项的真实数量
    const facets = { types: {}, seasons: {}, colors: {}, status: {} };
    const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
    list.forEach((i) => {
      bump(facets.types, i.wear.type);
      (i.wear.seasons || []).forEach((s) => bump(facets.seasons, s));
      (i.wear.colors || []).forEach((c) => bump(facets.colors, c));
      bump(facets.status, i.wear.status);
    });

    const month = new Date().getMonth() + 1;
    return sendJSON(res, 200, {
      ok: true, items: list, facets, month, season: seasonOfMonth(month),
      dict: { types: WEAR_TYPES, seasons: WEAR_SEASONS, status: WEAR_STATUS }
    });
  }

  if (pathname === '/api/wardrobe/suggest' && req.method === 'GET') {
    const thisSeason = seasonOfMonth(new Date().getMonth() + 1);
    const season = validOf(WEAR_SEASONS, query.get('season'), thisSeason);
    // 只从「可穿」且适合当季的里面挑
    const pool = db.items.filter((i) => i.wear
      && i.wear.status === 'ready'
      && (!i.wear.seasons.length || i.wear.seasons.indexOf(season) !== -1));

    // 少穿的优先：随机取前 60%，长期压箱底的衣服才有机会被翻出来
    const pick = (types) => {
      const arr = pool.filter((i) => types.indexOf(i.wear.type) !== -1);
      if (!arr.length) return null;
      const sorted = arr.slice().sort((a, b) => (a.wear.wearCount || 0) - (b.wear.wearCount || 0));
      const head = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.6)));
      return withPath(db, head[Math.floor(Math.random() * head.length)]);
    };

    const dress = pick(['dress']);
    const outfit = {
      top: dress ? null : pick(['top']),
      bottom: dress ? null : pick(['bottom']),
      dress,
      outer: pick(['outer']),
      shoes: pick(['shoes']),
      accessory: pick(['accessory'])
    };
    const missing = Object.keys(outfit).filter((k) => !outfit[k] && k !== 'accessory');

    return sendJSON(res, 200, {
      ok: true, season, poolSize: pool.length, outfit, missing,
      dict: { types: WEAR_TYPES, status: WEAR_STATUS }
    });
  }

  // 已有数据库的补数据入口：往用户真实的衣柜结构里塞一批示例衣物
  if (pathname === '/api/wardrobe/demo' && req.method === 'POST') {
    const has = db.items.filter((i) => i.wear).length;
    if (has) {
      return sendJSON(res, 409, { ok: false, error: '已经有 ' + has + ' 件衣服了，不需要再导入示例' });
    }
    if (!db.locations.length) {
      return sendJSON(res, 400, { ok: false, error: '先去「记一件」里建一个收纳位置' });
    }
    const t = nowISO();
    const findByName = (re) => db.locations.find((l) => re.test(l.name));
    const wardrobe = findByName(/衣柜|衣橱|衣帽间/) || findByName(/卧室|卧房/) || db.locations[0];

    const ensureChild = (name) => {
      const found = db.locations.find((l) => l.parent === wardrobe.id && l.name === name);
      if (found) return found.id;
      const created = {
        id: genId('l'), name, parent: wardrobe.id, kind: 'compartment', box: null, createdAt: t
      };
      db.locations.push(created);
      return created.id;
    };

    const hanging = ensureChild('挂衣区');
    const fold = ensureChild('叠放区');
    const drawer = ensureChild('抽屉');
    const shoesLoc = (findByName(/鞋柜|鞋架/) || wardrobe).id;
    const topShelfLoc = findByName(/顶层|隔板|收纳箱|储物箱/) || wardrobe;

    const slotMap = {
      hanging, fold, drawer,
      shoes: shoesLoc,
      'top-shelf': topShelfLoc.id,
      laundry: drawer
    };
    const added = demoWearSpec().map((spec) => {
      const locId = slotMap[spec.slot] ||
        (spec.status === 'stored' ? topShelfLoc.id : hanging);
      return wearToItem(spec, locId, t);
    });

    db.items = db.items.concat(added);
    writeDB(db);
    return sendJSON(res, 201, { ok: true, added: added.length, wardrobe: wardrobe.name });
  }

  const itemMatch = pathname.match(/^\/api\/items\/(.+)$/);
  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);
    const idx = db.items.findIndex((x) => x.id === id);
    if (idx === -1) return sendJSON(res, 404, { ok: false, error: '物品不存在' });

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const cur = db.items[idx];
      if (body.name !== undefined) cur.name = String(body.name).trim() || cur.name;
      if (body.locId !== undefined) cur.locId = body.locId || null;
      if (body.note !== undefined) cur.note = String(body.note);
      if (body.qty !== undefined) {
        const n = Number(body.qty);
        if (Number.isFinite(n) && n > 0) cur.qty = n;
      }
      if (body.tags !== undefined) {
        const rawTags = body.tags;
        cur.tags = Array.isArray(rawTags)
          ? rawTags.map((x) => String(x).trim()).filter(Boolean)
          : String(rawTags).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      }
      if (body.wear !== undefined) {
        const wear = sanitizeWear(body.wear);
        if (wear) {
          // 编辑表单可能不带穿着历史，这里保留原值
          wear.wearCount = Math.max(
            Number.isFinite(Number(body.wear.wearCount)) ? Number(body.wear.wearCount) : 0,
            Number(cur.wear && cur.wear.wearCount) || 0
          );
          wear.lastWorn = body.wear.lastWorn || (cur.wear && cur.wear.lastWorn) || null;
          cur.wear = wear;
        } else {
          delete cur.wear;
        }
      }
      cur.updatedAt = nowISO();
      writeDB(db);
      return sendJSON(res, 200, { ok: true, item: withPath(db, cur) });
    }

    if (req.method === 'DELETE') {
      const gone = db.items[idx];
      db.items.splice(idx, 1);
      writeDB(db);
      // 东西删了，它的照片也就没用了
      if (gone && gone.photo) deletePhotoFile(gone.photo);
      return sendJSON(res, 200, { ok: true });
    }
  }

  return sendJSON(res, 404, { ok: false, error: '接口不存在' });
}

const server = http.createServer((req, res) => {
  let parsed;
  try {
    parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400');
  }
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/photos/')) {
    return servePhoto(res, pathname);
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.searchParams).catch((err) => {
      console.error('[api error]', err);
      if (!res.headersSent) {
        sendJSON(res, err.statusCode || 500, { ok: false, error: err.message || '服务端错误' });
      }
    });
    return;
  }
  serveStatic(res, pathname);
});

ensureStorage();
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  HomeBox 已启动');
  console.log('  本机访问： http://127.0.0.1:' + PORT);
  if (HOST !== '0.0.0.0') {
    console.log('  想在手机上试这个命令重启： HOST=0.0.0.0 node server.js');
  }
  console.log('  数据文件： ' + DB_FILE);
  console.log('');
});
