'use strict';

// HomeBox v2 全部建表语句（DDL）与 schema 迁移数组
// 依据 docs/v2/ARCHITECTURE.md §6，按 docs/v2/DECISIONS.md D2 删除了 items.currency 列。
//
// 说明：
//   1. 业务表（locations / items / members）主键沿用字符串 id —— 19 个旧 id 与照片目录、
//      衣柜分区、URL 全部绑着它，改成自增会打断这些既有引用。
//   2. 只有 events / notify_log / job_runs / mail_outbox 用 INTEGER AUTOINCREMENT
//      （无外部引用、会涨到万级）。混用是刻意的，不是疏忽。
//   3. 照片文件完全不动，items.photo 仍只存文件名。

// 当前 schema 版本，与 PRAGMA user_version 对齐
const SCHEMA_VERSION = 1;

// v1→v2 基线建表语句。整段在同一个事务里执行，任何一条失败都整体回滚。
const DDL_V1 = `
-- 位置：沿用字符串 id（19 个旧 id 原样保留）
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('home','room','furniture','compartment')),
  box_x REAL, box_y REAL, box_w REAL, box_h REAL,   -- 拆列：热力/面积要算，不存 JSON
  sort_order INTEGER NOT NULL DEFAULT 0,             -- 保持旧 JSON 数组顺序，树/列表顺序不变
  created_at TEXT NOT NULL
);
CREATE INDEX idx_loc_parent ON locations(parent_id);

-- 成员（P2 起启用，统一 id 'm_shared' 表示"全家共用"，不用 NULL）
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member','simple','guest')),
  pass_hash TEXT,                       -- 仅 admin；成员为空 = 点人头
  pass_ver INTEGER NOT NULL DEFAULT 0,  -- 改密码递增，作废旧 cookie
  recover_code TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

-- 物品。金额按整数分存（DECISIONS D2：单币种 CNY，不建 currency 列）
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  loc_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  category TEXT,               -- 8 类白名单；空 = 未分类
  expire_at TEXT,              -- 'YYYY-MM-DD'
  remind_days INTEGER,         -- NULL = 不提醒
  min_qty INTEGER,             -- NULL = 不提醒（旧数据全 NULL → 不进提醒）
  price_cents INTEGER,         -- 整数分，NULL = 未记录
  buy_date TEXT,               -- NULL = 日期未知，绝不默认今天
  owner_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'in_use'
        CHECK (state IN ('in_use','used_up','lent','discarded')),
  lend_to TEXT, lend_at TEXT,
  photo TEXT,                  -- 文件名，照片仍在 data/photos/
  tags TEXT NOT NULL DEFAULT '[]',   -- JSON 数组文本：搜索用 LIKE，聚合用 json_each
  wear_json TEXT,              -- 衣物属性整体存 JSON（1:1、从不独立查询，见架构 §6 论证）
  wear_status TEXT GENERATED ALWAYS AS (json_extract(wear_json,'$.status')) STORED,
  wear_last_worn TEXT GENERATED ALWAYS AS (json_extract(wear_json,'$.lastWorn')) STORED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_items_loc ON items(loc_id);
CREATE INDEX idx_items_owner ON items(owner_id);
CREATE INDEX idx_items_expire ON items(expire_at) WHERE expire_at IS NOT NULL;
CREATE INDEX idx_items_state ON items(state);
CREATE INDEX idx_items_upd ON items(updated_at DESC);   -- 搜索排序，语义禁改

-- 变更留痕（P1-2 / P2 起写入）
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  member_id TEXT,
  kind TEXT NOT NULL,   -- create/update/move/qty/lend/return/discard/used_up/migrate_v1
  payload TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ev_item ON events(item_id, created_at DESC);

CREATE TABLE reminder_acks (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                   -- expire/low_stock/lent/idle
  action TEXT NOT NULL,                 -- done/snooze/mute
  until_date TEXT,
  ack_date TEXT NOT NULL,               -- ack_date：当日不再进任何通知
  PRIMARY KEY (item_id, kind)
);

CREATE TABLE notify_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL,               -- mail/inapp
  sent_date TEXT NOT NULL,
  UNIQUE (item_id, kind, channel, sent_date)
);
CREATE INDEX idx_nl_recent ON notify_log(kind, sent_date);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  run_date TEXT NOT NULL,
  status TEXT NOT NULL,                -- running/ok/failed/skipped
  detail TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (job, run_date)               -- 幂等的全部秘密就在这一行
);

CREATE TABLE mail_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  kind TEXT,
  status TEXT DEFAULT 'pending',       -- pending/sent/failed
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT,
  sent_at TEXT
);

-- KV：planWidthM / schema_version / base_currency / mail 配置 / 通知开关 / ai_enabled
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// 迁移数组：按 version 升序，启动时逐条跑、每条包一个事务
// （node:sqlite 没有 db.transaction()，事务一律手写，见 lib/db.js）
const MIGRATIONS = [
  {
    version: 1,
    name: 'v1 基线：从 db.json 结构建出 v2 全部表',
    up(db) {
      db.exec(DDL_V1);
    }
  }
];

module.exports = { SCHEMA_VERSION, DDL_V1, MIGRATIONS };
