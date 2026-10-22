'use strict';

// 首次运行写入的示例数据
//
// 位置 id 是写死的（l_home / l_living …），必须与旧版保持一致：
// 这些 id 曾经出现在用户的 db.json、照片引用与前端收藏里，改了会对不上。
// 物品 id 一律现场生成（genId），没有外部引用。
//
// P1 只把落库方式从「一次 JSON 重写」改成「事务里逐行 INSERT」，
// 内容与旧版 seed() 逐字段相同。

const db = require('./db');
const locations = require('./repo/locations');
const items = require('./repo/items');
const events = require('./repo/events');
const { nowISO, genId } = require('./util');

// 示例布局：id / 名称 / 父 id / 类型 / 坐标
// box 为统一平面坐标（0 到 100），房间与家具共用一套坐标系；
// 格口（抽屉、隔板）不画在地图上，只在家具内部视图里出现，所以没有坐标。
const SEED_LAYOUT = [
  ['l_home', '我家', null, 'home', null],

  ['l_living', '客厅', 'l_home', 'room', { x: 4, y: 4, w: 44, h: 44 }],
  ['l_tvcab', '电视柜', 'l_living', 'furniture', { x: 10, y: 13, w: 24, h: 9 }],
  ['l_tvdrawer', '左侧抽屉', 'l_tvcab', 'compartment', null],
  ['l_sidetable', '沙发边几', 'l_living', 'furniture', { x: 8, y: 34, w: 14, h: 11 }],

  ['l_kitchen', '厨房', 'l_home', 'room', { x: 52, y: 4, w: 44, h: 26 }],
  ['l_lowerCab', '橱柜下层', 'l_kitchen', 'furniture', { x: 58, y: 11, w: 20, h: 9 }],
  ['l_pantry', '储物架第二层', 'l_kitchen', 'compartment', null],

  ['l_bedroom', '卧室', 'l_home', 'room', { x: 52, y: 34, w: 44, h: 32 }],
  ['l_nightstand', '床头柜', 'l_bedroom', 'furniture', { x: 58, y: 41, w: 13, h: 11 }],
  ['l_wardrobe', '衣柜', 'l_bedroom', 'furniture', { x: 80, y: 41, w: 13, h: 17 }],
  ['l_wrHanging', '挂衣区', 'l_wardrobe', 'compartment', null],
  ['l_wrFold', '叠放区', 'l_wardrobe', 'compartment', null],
  ['l_wrDrawer', '内衣抽屉', 'l_wardrobe', 'compartment', null],
  ['l_wardrobeTop', '顶层隔板', 'l_wardrobe', 'compartment', null],

  ['l_entry', '玄关', 'l_home', 'room', { x: 4, y: 52, w: 24, h: 30 }],
  ['l_shoecab', '鞋柜抽屉', 'l_entry', 'furniture', { x: 8, y: 62, w: 16, h: 11 }],

  ['l_bath', '卫生间', 'l_home', 'room', { x: 32, y: 52, w: 17, h: 30 }],
  ['l_mirrorCab', '镜柜', 'l_bath', 'furniture', { x: 36, y: 60, w: 9, h: 11 }]
];

// 示例物品：名称 / 位置 id / 备注 / 数量 / 标签
const SEED_ITEMS = [
  ['指甲刀', 'l_tvdrawer', '和挖耳勺放一起', 1, ['工具']],
  ['5 号电池', 'l_tvdrawer', '备用，4 节装', 4, ['耗材']],
  ['电视遥控器备用', 'l_tvdrawer', '', 1, []],
  ['Type-C 充电线', 'l_sidetable', '短的那根', 2, ['线材']],
  ['垃圾袋 备用卷', 'l_lowerCab', '', 3, ['耗材']],
  ['备用洗洁精', 'l_lowerCab', '', 1, []],
  ['干货 木耳', 'l_pantry', '注意防潮', 1, ['食品']],
  ['手电筒', 'l_nightstand', '停电时用', 1, ['应急']],
  ['换季被子', 'l_wardrobeTop', '真空袋装好', 2, ['换季']],
  ['备用钥匙', 'l_shoecab', '', 1, ['重要']],
  ['创可贴', 'l_mirrorCab', '', 1, ['药品']],
  ['感冒药', 'l_mirrorCab', '看有效期', 1, ['药品']]
];

// 示例衣物的「习惯放哪」→ 示例布局里的具体格口
const WEAR_SLOT = {
  hanging: 'l_wrHanging',
  fold: 'l_wrFold',
  drawer: 'l_wrDrawer',
  shoes: 'l_shoecab',
  'top-shelf': 'l_wardrobeTop',
  laundry: 'l_wrDrawer'
};

/**
 * 示例布局的 id → 坐标映射。老数据缺坐标时用它补齐（旧版 ensureStorage 的行为）。
 * @returns {Record<string,{x:number,y:number,w:number,h:number}>}
 */
function boxHints() {
  const map = {};
  SEED_LAYOUT.forEach((entry) => {
    if (entry[4]) map[entry[0]] = entry[4];
  });
  return map;
}

/**
 * 在事务里写入整份示例数据。
 * @returns {{locations:number, items:number}}
 */
function writeSeed() {
  const t = nowISO();
  return db.tx(() => {
    SEED_LAYOUT.forEach((entry, index) => {
      db.prepare('INSERT INTO locations (id, name, parent_id, kind, ' +
        'box_x, box_y, box_w, box_h, sort_order, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(entry[0], entry[1], entry[2], entry[3],
          entry[4] ? entry[4].x : null, entry[4] ? entry[4].y : null,
          entry[4] ? entry[4].w : null, entry[4] ? entry[4].h : null,
          index, t);
    });

    const plain = SEED_ITEMS.map((row) => ({
      id: genId('i'),
      name: row[0],
      locId: row[1],
      note: row[2] || '',
      qty: row[3] == null ? 1 : row[3],
      tags: row[4] || []
    }));
    const wear = items.demoWearSpec().map((spec) => {
      const locId = WEAR_SLOT[spec.slot] ||
        (spec.status === 'stored' ? 'l_wardrobeTop' : 'l_wrHanging');
      return items.wearToItem(spec, locId, t);
    });
    const all = plain.concat(wear);
    all.forEach((item) => {
      items.insertItem(item, t, t);
      events.log({
        itemId: item.id, kind: 'create', payload: { seed: true, name: item.name }
      });
    });

    db.setSetting('planWidthM', 12);
    db.setSetting('base_currency', 'CNY');   // DECISIONS D2：固定单币种，只供导出文件自描述
    db.setSetting('schema_version', db.info().schemaVersion);

    return { locations: SEED_LAYOUT.length, items: all.length };
  });
}

/**
 * 空库时写入示例数据。只有「新建数据库文件」那一刻才会走到这里，
 * 所以不会出现「用户把东西删光了，重启又冒出一堆示例」的情况。
 * @returns {{locations:number, items:number}} 写入条数；已有数据则不写
 */
function seedIfEmpty() {
  if (locations.count() > 0) return { locations: 0, items: 0 };
  if (items.count() > 0) return { locations: 0, items: 0 };
  return writeSeed();
}

/**
 * 老数据补坐标：早期版本的数据没有平面坐标，从示例布局里把已知 id 的坐标补齐，
 * 这样老数据也能直接出现在家的地图上，且不会动到已录入的物品。
 * @returns {number} 被补上的位置数量
 */
function backfillKnownBoxes() {
  const hints = boxHints();
  const rows = db.prepare('SELECT id FROM locations WHERE box_x IS NULL AND box_y IS NULL ' +
    'AND box_w IS NULL AND box_h IS NULL').all();
  const targets = rows.map((r) => String(r.id)).filter((id) => hints[id]);
  if (!targets.length) return 0;
  const stmt = db.prepare('UPDATE locations SET box_x = ?, box_y = ?, box_w = ?, box_h = ? ' +
    'WHERE id = ?');
  db.tx(() => {
    targets.forEach((id) => {
      const b = hints[id];
      stmt.run(b.x, b.y, b.w, b.h, id);
    });
  });
  return targets.length;
}

module.exports = {
  SEED_LAYOUT,
  SEED_ITEMS,
  WEAR_SLOT,
  boxHints,
  writeSeed,
  seedIfEmpty,
  backfillKnownBoxes
};
