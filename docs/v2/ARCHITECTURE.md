# HomeBox v2 技术方案与四项技术裁定

> 架构师 高见远 · 依据 `docs/v2/PRD.md`、`server.js`(971 行)、`public/app.js`(1647 行)、`data/db.json`(19 位置/26 物品)
> 事实标注：**[官方]** 官方文档/发布说明 · **[实测]** 本机 Node 22.22.2 实跑 · **[估算]** 合理推算 · **[待验证]** 需在你的板上确认

## 0 四个问题的裁定表（30 秒版）

| # | 问题 | 推荐方案 | 一句话理由 | 工作量 |
|---|---|---|---|---|
| Q1 | 数据层 | **SQLite，走 `node:sqlite`（内置，0 依赖）**；不拆 JSON 文件 | 分文件救不了并发与聚合；`node:sqlite` 是唯一能同时拿到事务/索引且不破坏零依赖的路 | 4–6 天 |
| Q2 | 定时+邮件 | **进程内调度器 + `job_runs` 幂等表 + 手写 SMTP** | 一天只算一次的任务不值得 systemd 双份状态；nodemailer 值 1 个包但不值这 200 行 | 5–7 天 |
| Q3 | 鉴权+金额 | **scrypt + HMAC 无状态 Cookie（不引 JWT）；金额 `price_cents INTEGER`** | 无状态是为了不落 session 表（每次请求都写卡）；整数分是唯一不出错的存法 | 5–7 天 |
| Q4 | 依赖+识别 | **内置优先；识别走云端 OpenAI 兼容接口（内置 fetch），默认关 + 静默降级** | 本地部署在 4GB ARM 上不现实，而单次识别 ¥0.002（Flash 档免费）——决策点根本不在钱 | 3–4 天 |

**合计 17–24 人日（4–5 周单人流）**，四阶段均可独立上线、可回滚（§10）。

## 1 现状基线（6 个必须正视的事实）

| # | 事实 | 对设计的影响 |
|---|---|---|
| 1 | `readDB()` 解析失败时**静默返回 `seed()`**（server.js:431-434） | ⚠️ 最高危陷阱：坏文件→显示示例数据→用户一点→`writeDB` 把真实数据覆盖成种子。**P1 第一件事：删掉此 fallback，改为报错退出** |
| 2 | `writeDBRaw` 每次全量 `stringify`+`rename`（:438-442） | 只保证「不写半截」，**不覆盖并发读-改-写**：两人同点「已买」，后者覆盖前者。v2 加了提醒动作后这会变成日常 |
| 3 | `db.json` 是 `version:1`，而 `seed()` 写 `version:2` | 版本字段已不可信。迁移**靠结构探测**（有 `locations` 数组=v1），不靠 version |
| 4 | 19 个位置 id 是字符串（`l_mvd5505yr6vah` 等） | **主键必须沿用字符串**，改自增会打断照片目录与衣柜分区的既有引用 |
| 5 | 14 件衣物共享 `wear` 子对象（1:1，从不做集合运算） | `wear` 留 JSON 列（§6 有论证） |
| 6 | 版本号其实有 **4 处**：`style.css?v=7`、`app.js?v=7`、`APP_VERSION='v7'`、`sw.js CACHE='homebox-v7'` | 手改 4 处必漏；§9 给「服务端注入」的 15 行替代 |

**Node 版本的硬门槛（本次最重要外部事实）**

| 事实 | 来源 | 后果 |
|---|---|---|
| `node:sqlite` 22.5.0 引入，**22.13.0 起去掉 `--experimental-sqlite`**，25.7.0 起 Stability 1.2（RC） | [官方] Node 22.13.0 release notes（`unflag sqlite module #55890`）、nodejs docs/sqlite | 底线 **Node ≥ 22.13** |
| **Node 24.0.0 起不再提供 32 位 Linux armv7 预编译包**；Node 22.23.x 仍有 `linux-armv7l` | [官方] v22→v24 迁移指南；v22.23.1 发布页 | **32 位板只能停 Node 22.x**，与用不用 SQLite 无关 |
| 实测：WAL、`user_version`、`json1`（`json_extract`/`json_group_array`）全部可用，SQLite **3.51.2**；`db.transaction` **不存在** | [实测] Node 22.22.2 | 事务要手写；`wear` 走 JSON 列可行 |

> `engines.node` 由 `>=16` 收紧为 **`>=22.13`**（armv7 板额外 `<25`）。这是 v2 唯一不给退路的门槛。

## 2 Q1 数据层

### 2.1 三方案对比

| 维度 | A 拆 JSON 分文件 | B SQLite + `better-sqlite3` | **C SQLite + `node:sqlite`** |
|---|---|---|---|
| 依赖 | 0 | 1 原生包 + node-gyp | **0（内置）** |
| ARM 安装 | 无成本 | 32 位 armv7 很可能**无预编译包**，板上编译 20–40 分钟且常失败 [待验证] | 跟随 Node，零安装 |
| 原子性 | 单文件 rename 原子，**跨文件不原子**（位置删了物品没改→悬空 locId） | 完整 ACID | 完整 ACID |
| 并发 | 无锁，写者互相覆盖 | 单写者排队 | 单写者排队（同步 API） |
| 聚合（金额/统计） | 全量加载后在内存算 | SQL | SQL |
| 重写数据层 | ~150 行 | 600–800 行 | 600–800 行 |
| 主要风险 | 一致性靠人肉纪律 | 原生模块绑 ABI，升级 Node 需重编译 | RC 期 API 可能微调 |
| 结论 | 拒绝 | 弱（安装风险） | **采纳** |

### 2.2 「TF 卡写入量」的诚实结论

先说清：**这不是选 SQLite 的主要理由，别拿它当卖点。**

| 场景 | 单次写入 | 50 次/天年写入 |
|---|---|---|
| JSON 全量重写（300 件≈80KB） | ~80KB + rename | **≈1.4 GB/年** [估算] |
| SQLite WAL 单笔更新 | 1–3 个 4KB 页 + WAL 帧 ≈10KB | **≈180 MB/年** [估算] |

差 5–10 倍，但相对**照片**都是零头（一张压缩后 200–500KB，26 件物品现在才 16KB）。TF 卡真凶是照片和 `/var/log`。**选 SQLite 的真实理由是事务一致性 + 聚合查询 + 提醒计算的 JOIN 能力，省写入只是顺带。**

### 2.3 PRAGMA 取值（照抄）

```sql
PRAGMA journal_mode = WAL;         -- 读写不互斥，断电只丢未提交事务，不留半截文件
PRAGMA synchronous = NORMAL;       -- 推荐：FULL 每次 commit 双 fsync，卡寿命代价翻倍；OFF 可能损坏，拒绝
PRAGMA busy_timeout = 5000;        -- 两人同点「已买」时排队 5 秒而非立即报错
PRAGMA foreign_keys = ON;          -- node:sqlite 默认不开，必须显式开
PRAGMA wal_autocheckpoint = 1000;  -- 约 4MB 回写，防 -wal 膨胀
```
`NORMAL` 断电最坏**丢最后 1 个事务（≈1 次点击）但库不坏**；`FULL` 连这 1 次也不丢，代价是写入放大 ~2 倍。家庭场景取 NORMAL。

### 2.4 schema 版本管理

用 `PRAGMA user_version`（[实测] 可读写），迁移写成数组，启动时逐条跑、每条包事务：`BEGIN → up(db) → PRAGMA user_version=n → COMMIT`，catch 里 `ROLLBACK` 并抛错。同时在 `settings.schema_version` 冗余一份，供交叉校验（`user_version` 被外部工具覆盖时有兜底）。

### 2.5 迁移方案与验收标准

| 项 | 做法 |
|---|---|
| 触发 | 启动探测：无 `data/homebox.db` 且有 `data/db.json` → 自动迁移 |
| 映射 | `locations[]`→表（`parent`→`parent_id`，`box` 拆 4 列 REAL）；`items[]`→表（`wear` 整体进 `wear_json`，`tags` 进 JSON 文本）；`settings.planWidthM`→KV |
| 照片 | **完全不动**，`data/photos/` 原样，`items.photo` 仍存文件名 → 零风险 |
| 补字段 | 26 件：`category` 空（显示「未分类」）、`state='in_use'`、`expire_at/min_qty/price_cents` 全 NULL（→ 不进提醒）；14 件衣物回填 `category='衣物'`；每件写 1 条 `events(kind='migrate_v1')` |
| 备份 | 迁移**前** `db.json`→`data/backup/db.pre-v2.<ts>.json`，原文件只改名 `.migrated` 留档不删 |
| **验收** | ①locations 19 ②items 26 ③`wear_json IS NOT NULL` 14 ④`photo IS NOT NULL` 1 ⑤`planWidthM='12'` ⑥id 集合逐行一致 ⑦每条 `parent_id` 都能在表内找到 ⑧`integrity_check=ok`。任一不符→ROLLBACK+保留 JSON+启动失败并打印原因 |
| 回滚 | 删 `data/homebox.db*`，`db.json.migrated` 改回 `db.json`，代码回退。**3 分钟** |

## 3 Q2 定时任务 + 邮件

### 3.1 任务形态

| 维度 | A systemd timer 调脚本 | **B 进程内 setInterval + `job_runs`** |
|---|---|---|
| 状态一致性 | 两套状态源（timer + 应用库） | 同一事务写 `job_runs`，强一致 |
| 装机成本 | 要 `systemctl enable`，路径/node 位置写死 | 零配置，`npm start` 就有 |
| 补跑 | timer 自动再触发（唯一优点） | 靠启动 catch-up（需显式实现） |
| 卡寿命 | 每次醒来 fork Node（60–80MB RSS） | 复用常驻进程 |
| 结论 | 拒绝 | **采纳** |

**幂等 + 补跑（不重发、不漏发）**

| 场景 | 处理 |
|---|---|
| 正常 | 每 5 分钟 tick，判断「已到今天发送时间」且 `job_runs` 无今日 ok 记录 → 执行 |
| 断电 3 天重启 | catch-up 只跑**最近一次**窗口，邮件加「已暂停 N 天」说明；**绝不补发 3 封** |
| 两次 tick 撞车 | 插 `job_runs(job='daily',run_date)`，`UNIQUE` 冲突=别人在跑，直接让位 |
| 发送失败 | `status='failed'`，20 分钟后重试 ≤3 次；仍失败→站内提醒页顶部红字 + 保留清单 |
| 静默期 21:00–08:00 | 不执行、不写库、顺延次日 08:00 |
| 连续 3 天无人开 App | 用 `members.last_seen_at` 最大值判断，暂停邮件，恢复后合并 1 封 |

> 树莓派无 RTC 常见，系统时钟不可靠：日期判断全用**本地日期字符串** `YYYY-MM-DD`，启动时若 `now < 上次 run_date`（时钟回拨）→ 跳过当天，绝不倒着补。

### 3.2 邮件：手写 vs nodemailer

| 维度 | A 手写（内置 `tls`/`net`） | B nodemailer |
|---|---|---|
| 代码量 | 200–250 行（AUTH LOGIN、dot-stuffing、RFC2047 主题、multipart/alternative） | 0 |
| 依赖树 | 0 | 1 直接 + ~10 传递，~1.5MB |
| 能力 | 足够「一家邮箱 + 纯文本/简单 HTML 日报」 | 全功能（附件、DKIM 签名） |
| 结论 | **采纳** | 拒绝（将来要附件/模板再引入） |

**国内家用宽带的邮件现实（配置页必须写，不是可选说明）**

| 事实 | 影响 | 处理 |
|---|---|---|
| 25 端口（明文 SMTP）家用宽带普遍被封 [经验事实，以运营商为准] | 用 25 必然失败 | 只实现 **465 隐式 TLS** 与 **587 STARTTLS**，UI 就这两个下拉 |
| QQ/163 需网页端开「SMTP 服务」并生成**授权码**（不是登录密码） | 填密码必然 535 | 密码框固定文案「填**授权码**，不是登录密码」+ 获取链接；内置 QQ/163/自定义 3 个预设，选中自动填 host/port |
| SPF/DKIM：用 provider 的 SMTP 发、`From` 也用 provider 地址 → provider 的 SPF 覆盖、DKIM 由它签 | 伪造自有域名直接进垃圾箱 | **硬规则：`From` 必须=登录账号**，v2 不支持自有域名 |
| 首封易进垃圾箱 | 用户以为坏了 | 「发测试邮件」按钮暴露 SMTP 原始错误码；带 `List-Unsubscribe` 头；提示「首次可能在垃圾箱，标记为非垃圾」 |

**失败不阻塞主流程**：`mailer.send()` 永不 throw 到请求路径，只往 `mail_outbox` 写一行返回 `{queued:true}`；投递在独立 tick 做。任何 HTTP 请求都不等 SMTP。

### 3.3 提醒计算的查询条件（条件，不是代码）

| 提醒类 | SQL 条件 | 硬约束落地 |
|---|---|---|
| 过期 | `expire_at IS NOT NULL AND date(expire_at,'localtime') <= date('now','localtime','+'||remind_days||' days')` 且 `state='in_use'` | `IS NOT NULL` 放最外层第一句 |
| 低库存 | `min_qty IS NOT NULL AND qty < min_qty AND state='in_use'` | 旧数据全 NULL → 永不命中 |
| 借出未还 | `state='lent' AND lend_at IS NOT NULL AND julianday('now')-julianday(lend_at)>=30` | `lend_at IS NOT NULL` |
| 闲置 | 默认关；开关 on 才进查询：`updated_at < date('now','-365 days')` | 默认关闭 |
| 7 天收敛 | `NOT EXISTS(SELECT 1 FROM notify_log WHERE item_id=i.id AND kind=? AND sent_date > date('now','-7 days'))` | 同件同类 7 天 1 次 |
| 已处理当日静默 | `NOT EXISTS(... reminder_acks ... ack_date = date('now'))` | PRD「已处理当天不再出现」 |

> **铁律**：每条提醒查询的第一个 `WHERE` 条件必须是 `IS NOT NULL`。旧数据字段全空，这条保证「升级当天不会被 26 件空字段物品轰炸」，即 PRD P0-2 的验收点。

## 4 Q3 鉴权 + 金额

### 4.1 会话凭证

| 方案 | 存储成本 | 依赖 | 撤销 | 结论 |
|---|---|---|---|---|
| 服务端 session 表 | **每次请求 1 次写**（滑动过期）→ 一天几百次写卡 | 0 | 强 | 拒绝（为省卡值得放弃） |
| JWT 库 | 0 | 1 包 | 无 | 拒绝 |
| **HMAC 无状态 Cookie** | 0 写 | **0（内置 crypto）** | 弱→用 `pv` 字段补足 | **采纳** |

| 项 | 取值 |
|---|---|
| 密码哈希 | `scryptSync(pw, salt16B, 64)`，存 `scrypt$16384$8$1$<salt>$<hash>`，校验用 `timingSafeEqual`。ARM 上 50–100ms [估算]，登录态够用 |
| Cookie | `hb_sid` = `base64url(JSON{mid,role,pv,exp}) + '.' + base64url(HMAC-SHA256)`；`HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`（7 天滑动） |
| 密钥 | `data/secret.key`，首启 `randomBytes(32)`，`chmod 0600`。删掉=全员重登（即「退出所有设备」） |
| `pv`（password version） | 改密码 +1，旧 cookie 立即失效——**用 1 个字段换来 session 表的撤销能力** |
| 成员点人头 | 成员不设密码，点即签发 cookie（`pv=0`）。实现上只是「跳过密码校验」，PRD Q4 的方案零额外成本 |
| 忘记密码 | 家庭场景**不做邮件重置**：① 命令行 `node scripts/reset-password.js <名字>` ② 装机时打印 8 位恢复码让用户抄在路由器背面。两者都进 README |
| CSRF | `SameSite=Lax` 挡跨站 POST（覆盖 99%）+ 所有写接口额外要求头 `X-HB-AJAX: 1`（跨站无法自带自定义头，否则触发 preflight）。**不用 CSRF token 表**（又是写卡）。同时保证**没有改状态的 GET 接口**（现有代码已满足） |

### 4.2 金额分级可见：在接口层拦

不做「前端隐藏」，做**单一序列化出口**：`lib/roles.js` 里 `CAN_SEE_PRICE={admin:1,member:1,simple:0,guest:0}` + `forRole(obj,role)`（非授权档直接删 `price_cents/total_cents/currency`）。所有返回物品的路径必须经过它。需要拦截的接口：`GET /api/items`、`GET /api/items/:id`、`GET /api/stats/value`（访客/精简 403）、`GET /api/export`（403）、`GET /api/reminders`、`GET /api/locations`（房间金额字段）。**统计接口的角色校验放路由最前面，不能靠前端不显示。**

### 4.3 金额：整数分

| 项 | 决定 | 理由 |
|---|---|---|
| 存储 | `price_cents INTEGER NULL`（可空=未记录） | 浮点 `0.1+0.2` 漂移；SQLite 无 DECIMAL；`SUM()` 500 行累出分位误差。整数分加乘全精确 |
| 输入 | 前端 `¥12.30 → Math.round(v*100)`，只在入口转一次 | — |
| 单件小计 | `price_cents * qty`（整数乘） | 口径明确：**单价 × 当前数量** |
| 两个口径 | 在库 `Σ(price_cents*qty) WHERE state='in_use'`；累计购入 `Σ(price_cents*qty)` 全状态 | 与 PRD Q3 一致，两数并列，不混 |
| 多币种 | 存 `currency`（默认继承 `settings.base_currency='CNY'`），**按币种分列小计、v2 不做汇率换算** | 换算要维护汇率源=外部依赖+数据出门，收益极低。3 个币各一行比一个假汇率诚实 |
| 空值语义 | `NULL` 不计金额、但计入「未记录 X 件」覆盖率 | 避免「总价值 ¥0」误读 |
| 已知失真 | 事后改 `qty` 会改变历史口径 | `events` 留痕 + 概览脚注「按当前数量估算」。彻底解决需 `purchase_qty`，v2 不做 |

### 4.4 风险诚实评估

| 项 | 结论 |
|---|---|
| 防什么 | 防**家人误操作**、防**访客看金额**、防**精简档误触**。**不防**局域网内攻击者 |
| 能否标 `Secure` | **不能**。默认 `http://192.168.x.x`，标了浏览器直接丢 cookie→全员登不上。做法：按 `req.socket.encrypted` 动态决定（走 Tailscale/反代 https 时自动生效） |
| 无 HTTPS 的边界 | 同 WiFi 下任何人可嗅探 cookie 冒充。家庭 WPA2 场景可接受；有访客网络/合租时**强烈建议 Tailscale**（免费、自带 https、顺带解决公网访问） |
| 密码强度 | 只要求 ≥6 位、不比复杂度——家庭场景的敌人是「记不住」而非「爆破」，且 `scrypt` 已让离线爆破变慢 |

## 5 Q4 依赖边界 + 拍照识别

### 5.1 「依赖」的三层含义

| 层 | 定义 | 代价 | 态度 |
|---|---|---|---|
| L1 内置模块 | `node:sqlite`/`crypto`/`tls`/`fetch` | 0 | **优先，能用就用** |
| L2 单文件内联 | 自己写或 vendor 的 `lib/xxx.js`（无 package.json） | 0 依赖，自己维护 | 接受（SMTP 客户端） |
| L3 npm 包 | `npm install` 才有 | 安装/体积/ABI/供应链 | **默认拒绝**，除非省 >500 行且无替代 |

### 5.2 v2 依赖决策表

| 能力 | 选型 | 判定 | 不引入的替代 + 代价 |
|---|---|---|---|
| 数据库 | `node:sqlite` | **必须**(L1) | 无替代（§2） |
| 密码哈希 / 会话签名 | `crypto.scrypt` / `createHmac` | **必须**(L1) | JWT 包：多 1 包换 15 行 |
| HTTP 客户端（识别） | 全局 `fetch`（Node 18+） | **必须**(L1) | axios：多 1 包换 3 行 |
| 定时 | `setInterval`+`job_runs` | **必须**(L1) | node-cron：多 1 包且不解决幂等 |
| 邮件 | 自写 `lib/smtp.js` | **可选**(L2) | nodemailer：省 200 行，多 11 个包 |
| 图片处理 | 不做服务端处理 | **拒绝** | sharp：原生模块，ARM 装不上 + 3MB |
| 日期 | 手写 20 行日期工具 | **拒绝** dayjs | 需求只有格式化+加减天 |
| UUID | 沿用 `genId()` | **拒绝** uuid | 现有 id 命名空间必须保住 |
| 前端框架 | 原生 + innerHTML | **拒绝** React/Vue | 引构建链=毁掉「改完直接刷」 |
| 视觉 SDK | 无（直接 fetch POST JSON） | **拒绝** 各厂 SDK | SDK 只是拼 JSON，还锁死厂商 |

### 5.3 识别三条路线

| 路线 | 评估 | 结论 |
|---|---|---|
| **a 云端视觉 API** | 一次 HTTPS POST + base64。国内可用：**智谱 GLM-4.6V-Flash 永久免费 / GLM-4.6V ¥1/¥3 每百万 token**、**通义 qwen3-vl-plus ≈¥1.4/¥1.4**、**豆包 Seed-2.0-mini ¥0.2/¥2** [官方定价页，档位/汇率 [待验证]]。均 OpenAI 兼容 `chat/completions`；结构化输出优先 `response_format`，不支持时退回「提示词要纯 JSON + 剥 ``` 围栏 + schema 校验」 | **采纳** |
| **b 本地部署** | 香橙派 AI Pro（昇腾 310B）要 CANN/OM 工具链、模型转 om 是另一个项目；树莓派 4GB 跑 Qwen2-VL-2B 量化≈1.5–2GB 常驻 + 视觉编码器，单张 5–15 秒 [估算]，还要与 Web 服务抢内存 | **拒绝**（v3 可做实验，不进 v2 排期） |
| **c 浏览器端** | 手机首下 300MB–1GB 模型；iOS Safari 的 WebGPU 支持不稳；安卓中端机单张 8–20 秒 [估算] | **拒绝**（慢到没人用，做开关也无意义） |

### 5.4 降级链（本条重点，不是模型选型）

| 环节 | 行为 |
|---|---|
| 未配置 Key / 用户在设置里关了 | `/api/vision/recognize` 返回 **404**，前端**根本不渲染拍照按钮**。不是「点了报错」 |
| 调用 | 6 秒超时，`AbortController`；失败不重试超过 1 次 |
| 超时 / 429 / 5xx / JSON 坏了 | 返回 `200 {ok:true, disabled:true, hint:'识别暂不可用，先手动记'}` → 前端顶部一行灰字，**表单照常可用，不弹窗、不阻断** |
| 成功 | 白名单收敛：`category` 必须∈8 类，越界→「其他」；字段长度截断；`guessLocId` 必须真实存在，否则丢弃 |
| 落库 | 结果只进表单 DOM，**`POST /api/items` 是唯一落库入口**（天然成立，不需额外设计） |
| 隐私 | `settings.ai_enabled` 默认 0；开启时弹一次确认「照片会以压缩后 720px 发送给 XXX，本机不留存」；服务端**不写日志、不落盘**，仅内存转发 |

### 5.5 成本估算

单次约 1000–2000 输入 token（720px 图）+ 150 输出 token：

| 模型 | 单次 | 一家 4 口×20 次/月=80 次 | 极端 300 次/月 |
|---|---|---|---|
| GLM-4.6V-Flash | **¥0（永久免费）** | **¥0** | ¥0 |
| GLM-4.6V | ≈¥0.0025 [估算] | ≈¥0.2 | ≈¥0.8 |
| qwen3-vl-plus | ≈¥0.003 [估算] | ≈¥0.25 | ≈¥1 |
| 豆包 Seed-2.0-mini | ≈¥0.001 [估算] | ≈¥0.1 | ≈¥0.3 |

> **月成本量级 < ¥1，所以「省钱」不能当选型理由。**默认免费 Flash 档（准确率略低但可降级），要更准让用户在设置里换。真成本是「一次失败让用户多打 5 个字」——降级链比模型重要。

## 6 数据模型 v2

```sql
-- 位置：沿用字符串 id（19 个旧 id 原样保留）
CREATE TABLE locations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  parent_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('home','room','furniture','compartment')),
  box_x REAL, box_y REAL, box_w REAL, box_h REAL,   -- 拆列：热力/面积要算，不存 JSON
  sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX idx_loc_parent ON locations(parent_id);

-- 成员：共用用保留 id 'm_shared'，不用 NULL（NULL 表示旧数据的「未指定」）
CREATE TABLE members (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member','simple','guest')),
  pass_hash TEXT,                                  -- 仅 admin；成员为空 = 点人头
  pass_ver INTEGER NOT NULL DEFAULT 0,             -- 改密码递增，作废旧 cookie
  recover_code TEXT, created_at TEXT NOT NULL, last_seen_at TEXT);

CREATE TABLE items (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  loc_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL DEFAULT 1 CHECK (qty>0),
  category TEXT,            -- 8 类白名单；空=未分类
  expire_at TEXT,           -- 'YYYY-MM-DD'
  remind_days INTEGER,      -- NULL=不提醒
  min_qty INTEGER,          -- NULL=不提醒（旧数据全 NULL → 不进提醒）
  price_cents INTEGER,      -- 整数分
  currency TEXT, buy_date TEXT,   -- buy_date NULL=日期未知，绝不默认今天
  owner_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'in_use'
        CHECK (state IN ('in_use','used_up','lent','discarded')),
  lend_to TEXT, lend_at TEXT,
  photo TEXT,                                    -- 文件名，照片仍在 data/photos/
  tags TEXT NOT NULL DEFAULT '[]',               -- JSON 数组文本：搜索用 LIKE，聚合用 json_each
  wear_json TEXT,                                -- 见下方论证
  wear_status TEXT GENERATED ALWAYS AS (json_extract(wear_json,'$.status')) STORED,
  wear_last_worn TEXT GENERATED ALWAYS AS (json_extract(wear_json,'$.lastWorn')) STORED,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_items_loc ON items(loc_id);
CREATE INDEX idx_items_owner ON items(owner_id);
CREATE INDEX idx_items_expire ON items(expire_at) WHERE expire_at IS NOT NULL;
CREATE INDEX idx_items_state ON items(state);
CREATE INDEX idx_items_upd ON items(updated_at DESC);   -- 搜索排序，语义禁改

-- 变更留痕（P1-2）：只有它与 job_runs 用自增
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  member_id TEXT, kind TEXT NOT NULL,   -- create/update/move/qty/lend/return/discard/used_up/migrate_v1
  payload TEXT, created_at TEXT NOT NULL);
CREATE INDEX idx_ev_item ON events(item_id, created_at DESC);

CREATE TABLE reminder_acks (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- expire/low_stock/lent/idle
  action TEXT NOT NULL,                  -- done/snooze/mute
  until_date TEXT, ack_date TEXT NOT NULL,   -- ack_date：当日不再进任何通知
  PRIMARY KEY (item_id, kind));

CREATE TABLE notify_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT, kind TEXT NOT NULL, channel TEXT NOT NULL,   -- mail/inapp
  sent_date TEXT NOT NULL,
  UNIQUE (item_id, kind, channel, sent_date));
CREATE INDEX idx_nl_recent ON notify_log(kind, sent_date);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL, run_date TEXT NOT NULL,
  status TEXT NOT NULL,      -- running/ok/failed/skipped
  detail TEXT, started_at TEXT, finished_at TEXT,
  UNIQUE (job, run_date));   -- 幂等的全部秘密就在这一行

CREATE TABLE mail_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT, subject TEXT, body_text TEXT, body_html TEXT, kind TEXT,
  status TEXT DEFAULT 'pending',      -- pending/sent/failed
  attempts INTEGER DEFAULT 0, last_error TEXT, created_at TEXT, sent_at TEXT);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- KV：planWidthM / base_currency / mail 配置 / 4 类通知开关 / ai_enabled / schema_version
```

**主键策略**：业务表（locations/items/members）沿用**字符串 id**——19 个旧 id 与照片、衣柜分区、URL 全绑着它；只有 `events`/`notify_log`/`job_runs`/`mail_outbox` 用 `AUTOINCREMENT`（无外部引用、会涨到万级）。混用是刻意的，不是疏忽。

**`wear` 为什么留 JSON 列不拆表**

| 论点 | 说明 |
|---|---|
| 1:1 且从不独立查询 | 衣柜接口是「取全部衣物（14 行）+ 内存算 facets」，没有需要索引的路径 |
| 拆表成本 > 收益 | 多 1 次 JOIN、1 套 CRUD、多一段迁移映射，换 0 性能（14 行 vs 26 行无差别） |
| json1 已验证可用 | `json_extract` 可用（[实测] 3.51.2）→ 用 **GENERATED STORED 列**投影 `wear_status`/`wear_last_worn`，既能建索引又不重复写代码 |
| 未来可拆 | `wear_json` 是单一来源，真要拆一条 `INSERT...SELECT` 就够 |

## 7 后端代码结构（971 行的拆法）

预估 v2 **2200–2600 行 / 18 文件**。单文件会到 2400 行，必须拆；但**不引构建、不用 ESM**，全 CommonJS，`node server.js` 照旧能跑。

| 文件 | 职责 | 行 |
|---|---|---|
| `server.js` | http 创建、路由分派表、静态/照片、启动 | 150 |
| `lib/db.js` | 开库、PRAGMA、`tx(fn)` 手写事务、迁移执行、语句缓存 | 130 |
| `lib/schema.js` | 全部 DDL + `MIGRATIONS` | 130 |
| `lib/repo/locations.js` | 位置树 CRUD + `buildTree` + 坐标自动摆放（原逻辑平移） | 160 |
| `lib/repo/items.js` | 物品 CRUD + 状态动作 + 照片关联 + 搜索 | 220 |
| `lib/repo/members.js` | 成员 CRUD + 密码 | 90 |
| `lib/repo/stats.js` | 金额三维聚合、覆盖率、分布图 | 140 |
| `lib/repo/events.js` | 留痕写入 + 时间线 | 70 |
| `lib/repo/reminders.js` | 4 类提醒查询 + acks | 150 |
| `lib/auth.js` | scrypt、cookie 签发校验、`requireRole`、CSRF | 180 |
| `lib/roles.js` | 角色能力表 + `forRole()` 字段过滤 | 60 |
| `lib/smtp.js` | 手写 SMTP（AUTH LOGIN、dot-stuffing、RFC2047） | 220 |
| `lib/mailer.js` | 摘要邮件组装 + outbox 投递重试 | 150 |
| `lib/scheduler.js` | tick、catch-up、`job_runs` 幂等、静默期 | 110 |
| `lib/vision.js` | 识别代理、白名单收敛、超时降级 | 150 |
| `lib/http.js` | `sendJSON`/`readBody`/`tooLarge`/`requireAjax` | 90 |
| `lib/util.js` | `nowISO`/`daysSince`/`genId`/日期/`seasonOfMonth` | 70 |
| `scripts/{migrate-v1,export,reset-password}.js` | 迁移（可单独跑）、导出、重置密码 | 240 |

约束：**只有 `lib/db.js` 出现 `require('node:sqlite')`**（RC 期 API 若变，改动收敛到 1 文件）；**只有 `lib/roles.js` 决定谁能看金额**。

## 8 接口变更清单

**改签名（7）**：`GET /api/items`（加 `?cat=&owner=&state=&expiring=` + `forRole`）、`POST /api/items`（新字段 + ownerId 默认登录人 + 写 events｜admin/member/simple）、`PUT /api/items/:id`（金额变更写 events｜admin/member）、`POST /api/items/:id/wear`（走事务）、`GET /api/locations`（节点加 `valueCents`，按权限给）、`GET /api/wardrobe`（加 ownerId 维度）、`DELETE /api/items/:id`（**精简/访客 403**）。

**新增（16）**

| 方法与路径 | 说明 | 角色 |
|---|---|---|
| `POST /api/auth/setup` | 首建管理员（已有则 409） | 无 |
| `POST /api/auth/login` | 管理员密码 / 成员点人头 | 无 |
| `POST /api/auth/logout` · `GET /api/auth/me` | 清 cookie · 当前身份+能力表 | 全档 |
| `GET/POST /api/members` · `PUT/DELETE /api/members/:id` · `POST /api/members/:id/password` | 成员管理（5） | admin |
| `GET /api/stats/value?by=loc\|category\|owner&range=all\|year\|90d` | 金额概览 | admin/member（其余 403） |
| `GET /api/reminders` · `POST /api/reminders/:itemId/:kind/ack` | 今日待办（无金额）· done/snooze/mute | 全档 · admin/member |
| `POST /api/items/:id/state` | 一键：用完/借出/归还/丢弃 | admin/member |
| `GET /api/items/:id/events` | 物品时间线 | 全档 |
| `GET/PUT /api/notify/settings` · `POST /api/notify/test` | 订阅开关+邮箱配置 · 发测试邮件（同步返回 SMTP 错误） | admin |
| `POST /api/vision/recognize` | 识别代理（未启用→404） | admin/member |
| `GET /api/export` · `POST /api/import` | 人类可读导出/回灌（含照片清单） | admin |
| `GET /api/jobs/status` | 调度器状态（排查用） | admin |

## 9 前端改造量

`app.js` 1647 → **2600–3000 行**，拆 8 文件，仍**无构建、全局命名空间 `HB`**，`index.html` 顺序 `<script>`：

| 文件 | 内容 | 行 |
|---|---|---|
| `js/core.js` | `api()`（补 `X-HB-AJAX`）、state、toast、esc、`formatMoney`、角色镜像 | 260 |
| `js/search.js` | 搜索、卡片（+3 角标）、统计条 3→4 项、概览入口 | 420 |
| `js/map.js` | 户型 SVG、拖拽、四档热力、内部视图 | 620 |
| `js/wardrobe.js` | 四维筛选（+归属人）、今日穿什么、穿戴记录 | 520 |
| `js/add.js` | 记一件、字段折叠、记住上次位置、识别草稿确认、压缩 | 380 |
| `js/reminders.js` | 提醒页、红点、三动作、订阅管理 | 320 |
| `js/members.js` | 成员页、头像切换、登录/首导 | 280 |
| `js/stats.js` | 概览三页签、条形、覆盖率、两个口径 | 240 |

**5 个页签改动点**：①找东西—统计条 4 项且整条可点，卡片加金额/归属/过期 3 角标（访客/精简不渲染金额），右上角加「家」②地图—房间详情加「已记录金额」一行（只读），`box` 拆列前端无感，树形列表降为二级切换 ③衣柜—筛选栏加「归属人」，其余**一行不改**（回归重点保护），金额角标按角色隐藏 ④提醒—全新：分组清单+红点+三动作+订阅开关 ⑤记一件—大拍照按钮+名称+位置（记住上次），高级字段默认全折叠，食品/药品/日化自动展开过期日。

**版本号约定演进**：放弃手改 4 处，改服务端注入——`index.html` 写 `style.css?v=__V__`、`app.js?v=__V__`，`serveStatic` 对 html 做一次 `replace('__V__', buildStamp)`，`buildStamp` = public 目录文件**最大 mtime**（启动算一次）。15 行代码消掉一整类「用户看到旧缓存」工单；`sw.js` 的 `CACHE` 同步用 `homebox-${buildStamp}`。

## 10 分阶段路线图

| 阶段 | 目标 | 交付物 | 工时 | 验收 | 回滚 |
|---|---|---|---|---|---|
| **P1 数据层** | 迁到 SQLite，**行为 100% 不变** | `lib/{db,schema}.js`、`lib/repo/{locations,items,events}.js`、`scripts/{migrate-v1,export}.js`、`server.js` 改手脚 | **4–6 天** | §2.5 的 8 条校验全过；19/26/14/1 分毫不差；搜索排序、地图拖拽、衣柜四维筛选**回归零 Bug**；导出→再导入往返一致 | 删 `.db*`，恢复 `db.json.migrated` |
| **P2 鉴权+金额** | 四档角色 + 金额分级可见 | `lib/{auth,roles}.js`、`lib/repo/{members,stats}.js`、前端 `core/members/stats.js` | **5–7 天** | 首导可建管理员；加成员 ≤30s；精简档看不到任何金额与删除按钮；访客统计接口 403；概览 3s 内出数，未填价不显示 ¥0 | 关 `requireRole`（保留 admin 兜底），前端隐藏入口 |
| **P3 提醒+邮件** | 站内提醒中心 + 每日一封 | `lib/repo/reminders.js`、`lib/{smtp,mailer,scheduler}.js`、前端 `reminders.js` | **5–7 天** | 空字段物品**零提醒**（升级当天不炸）；断电 2 天重启只发 1 封；同件 7 天 1 次；21–08 点不发；测试邮件能给出明确失败原因 | 关 `settings.mail_enabled`，退回纯站内 |
| **P4 识别+收尾** | 拍照识别（可关）+ 导出导入 + PWA 版本注入 | `lib/vision.js`、前端 `add.js`、`scripts/export.js`、`index.html` 版本占位 | **3–4 天** | 未配 Key 按钮不出现；断网/超时只出一行灰字、表单可存；不点保存不落库；关开关后完全回手填 | 关 `ai_enabled`，接口 404，前端不渲染 |

**总 17–24 人日 + 整体回归 2 天 ≈ 20–26 人日（4–5 周单人流）。只做 P0（P1–P3）= 14–20 人日，P4 可延后独立上线。**

## 11 风险登记册

| # | 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | **TF 卡损坏** | 卡老化、断电、劣质卡 | 数据全丢 | 每日 03:00 自动 `export` 到 `data/backup/`（留 7 份）；README 强制「每周把 backup 拷到电脑/U 盘」；建议 A2 卡或上 SSD |
| R2 | **断电致 DB 损坏** | 直接拔电源 | 最坏丢最后 1 次操作 | WAL+`synchronous=NORMAL`：单页原子提交，**不会出现半截文件**；启动跑 `integrity_check`，坏则从最近备份恢复并告知用户 |
| R3 | **旧代码静默 seed 覆盖** | JSON 解析失败（现存风险） | 真实数据被示例覆盖且不可恢复 | **P1 第一天删除 `readDB` 的 catch→seed**，改为报错 + `exit(1)`；迁移前强制备份 |
| R4 | **邮件进垃圾箱** | 首次发送、`From` 与账号不一致 | 用户以为功能坏了 | `From` 必须=登录账号；带 `List-Unsubscribe`；测试邮件暴露 SMTP 原始码；文案提示查垃圾箱 |
| R5 | **API Key 泄露** | 导出文件含 Key、日志打印、前端回显 | 他人盗刷额度 | 任何接口**不返回明文**（只回「已配置/未配置」）；日志脱敏；导出剔除 Key；建议单独 `data/ai.key` 0600 |
| R6 | **迁移失败/半迁移** | 中途断电、字段类型不符 | 升级后打不开 | 单事务 + 8 条校验 + 不过就 ROLLBACK 并保留 JSON；`db.json` 只改名不删 |
| R7 | **Node 版本锁死** | armv7 板升 Node 24（无预编译包）；25.x 改 `node:sqlite` API | 装不上 / 启动崩 | `engines:">=22.13"`，32 位板额外 `<25`；`require('node:sqlite')` 只在 `lib/db.js`；启动打印 Node+SQLite 版本 |
| R8 | **局域网无 HTTPS** | 默认 http 部署 | cookie 可被同网嗅探，`Secure` 不能标 | 文档明确「防家人误操作与访客，不防局域网攻击者」；推荐 Tailscale；访客场景用访客 WiFi 隔离 |
| R9 | **并发写丢失** | 两人同点「已买」/改数量 | 后写覆盖先写 | 写操作包 `tx()`；`busy_timeout=5000`；状态动作用 `UPDATE ... WHERE state='in_use'` 乐观写法，`changes=0` 返回 409「已被家人改过，刷新看看」 |
| R10 | **同步 API 阻塞事件循环** | 全表聚合、`integrity_check` | 手机偶发卡顿 | 聚合走索引单次查询；`integrity_check` 只在启动跑；>500 件时概览结果缓存 60s |
| R11 | **提醒轰炸/漏发** | 重启、时钟回拨、多人处理同一件 | 用户关掉全部通知=功能死亡 | `job_runs` UNIQUE 幂等；catch-up 只补最近 1 次；`notify_log` 7 天收敛；`acks` 当日静默；时钟回拨检测 |
| R12 | **照片与 DB 不一致** | 删物品时文件删失败、手工改库 | 孤儿文件慢慢吃满卡 | 事务提交后再删文件（失败只记日志）；`scripts/gc-photos.js` 扫孤儿，可每周跑 |

## 12 待确认问题（只列影响架构的 5 条）

| # | 问题 | 我的推荐 | 选另一个的代价 |
|---|---|---|---|
| A1 | **你的板子是 32 位 armv7 还是 64 位 arm64？**（`uname -m` 一看就知道） | arm64 → Node 22/24 都可；**armv7 → 必须锁 Node 22.x** | 32 位 + Node 24 要自己在板上编译（30–60 分钟，常失败） |
| A2 | **多币种**：接受「按币种分列小计、不换算汇率」吗？ | **接受**。3 个币各一行比一个假汇率诚实 | 要换算就得引汇率源 → 数据出门 + 新依赖，与核心卖点冲突 |
| A3 | **邮件授权码存哪**：明文存 `data/settings`（文件 0600）还是环境变量？ | **明文 + 0600**。设备物理可得性已决定安全上限，环境变量会把「装好就能用」变成「装完还要配 systemd」 | 环境变量：多 1 配置步骤 + 多 1 类「重启后邮件没了」故障 |
| A4 | **识别默认厂商**：GLM-4.6V-Flash（免费）还是 GLM-4.6V（¥1/M，更准）？ | **默认免费 Flash**，设置里可切；降级链已保证「不准」不会阻塞 | 默认付费档：月成本仍 <¥1，但要先绑卡，装机多掉一批人 |
| A5 | **备份**：愿意每周插一次 U 盘/接 NAS 吗？（决定是否做 `backup.sh` + rsync + timer） | **愿意做「每周插 U 盘」**。自动备份到同一张卡等于没备份 | 不外部备份：必须接受「卡坏=数据全丢」，并在 README 第一行写清 |
