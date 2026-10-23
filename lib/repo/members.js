'use strict';

// 成员仓库：CRUD + 密码 + 身份查询
//
// 几条刻意的产品规则：
//   · 只有管理员有密码，其余成员「点人头」即进（家庭场景，防的是误操作不是入侵）；
//   · 永远不允许删掉最后一个管理员 —— 那会把全家锁在门外；
//   · 对外返回永远不带 pass_hash / recover_code，只给 hasPassword。

const db = require('../db');
const auth = require('../auth');
const { genId, nowISO } = require('../util');
const roles = require('../roles');

/**
 * 行 → 对外安全的成员对象（绝不带哈希）。
 * @param {object} row members 表行
 * @returns {object} 安全对象
 */
function rowToMember(row) {
  return {
    id: String(row.id),
    name: String(row.name),
    role: roles.validRole(row.role),
    hasPassword: !!row.pass_hash,
    createdAt: String(row.created_at),
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null
  };
}

/**
 * 成员总数。0 表示还没初始化（首次使用）。
 * @returns {number}
 */
function count() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM members').get();
  return Number(row ? row.c : 0);
}

/**
 * 全部成员，按创建时间升序（管理员通常在最前）。
 * @returns {object[]}
 */
function list() {
  return db.prepare('SELECT * FROM members ORDER BY created_at ASC, rowid ASC').all()
    .map(rowToMember);
}

/**
 * 取一个成员（对外形状）。
 * @param {string} id 成员 id
 * @returns {object|null}
 */
function get(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  return row ? rowToMember(row) : null;
}

/**
 * 鉴权用的成员信息（带 pass_ver 与角色，不含哈希）。
 * @param {string} id 成员 id
 * @returns {{id:string,name:string,role:string,passVer:number}|null}
 */
function getAuth(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    role: roles.validRole(row.role),
    passVer: Number(row.pass_ver) || 0
  };
}

/**
 * 校验密码（只有设过密码的成员才可能通过）。
 * @param {string} id 成员 id
 * @param {string} password 明文
 * @returns {{ok:boolean, member?:object}} 结果
 */
function checkPassword(id, password) {
  const row = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!row || !row.pass_hash) return { ok: false };
  if (!auth.verifyPassword(password, row.pass_hash)) return { ok: false };
  return { ok: true, member: rowToMember(row) };
}

/**
 * 新建成员。
 * @param {object} payload 入参
 * @param {string} payload.name 名字
 * @param {string} [payload.role] 角色，默认 member
 * @param {string} [payload.password] 密码（仅管理员需要）
 * @returns {{error?:{status:number,error:string}, member?:object, recoverCode?:string}}
 */
function create(payload) {
  const name = String((payload && payload.name) || '').trim();
  if (!name) return { error: { status: 400, error: '名字不能为空' } };
  if (name.length > 20) return { error: { status: 400, error: '名字太长了（最多 20 个字）' } };

  const role = roles.validRole(payload.role || 'member');
  const password = payload.password == null ? '' : String(payload.password);
  if (password && password.length < 6) {
    return { error: { status: 400, error: '密码至少 6 位' } };
  }
  const dup = db.prepare('SELECT id FROM members WHERE name = ?').get(name);
  if (dup) return { error: { status: 409, error: '已经有同名的成员了' } };

  const t = nowISO();
  const row = {
    id: genId('m'),
    name,
    role,
    pass_hash: password ? auth.hashPassword(password) : null,
    pass_ver: 0,
    recover_code: password ? auth.makeRecoverCode() : null,
    created_at: t,
    last_seen_at: null
  };
  db.tx(() => {
    db.prepare('INSERT INTO members (id, name, role, pass_hash, pass_ver, ' +
      'recover_code, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.name, row.role, row.pass_hash, row.pass_ver,
        row.recover_code, row.created_at, row.last_seen_at);
  });

  const out = { member: get(row.id) };
  // 恢复码只在这一个响应里出现一次，之后再也拿不到
  if (row.recover_code) out.recoverCode = row.recover_code;
  return out;
}

/**
 * 改名字 / 改角色。
 * @param {string} id 成员 id
 * @param {object} patch 入参
 * @returns {{error?:{status:number,error:string}, member?:object}}
 */
function update(id, patch) {
  const cur = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!cur) return { error: { status: 404, error: '成员不存在' } };

  let name = cur.name;
  if (patch.name !== undefined) {
    name = String(patch.name).trim();
    if (!name) return { error: { status: 400, error: '名字不能为空' } };
    if (name.length > 20) return { error: { status: 400, error: '名字太长了（最多 20 个字）' } };
    const dup = db.prepare('SELECT id FROM members WHERE name = ? AND id <> ?').get(name, id);
    if (dup) return { error: { status: 409, error: '已经有同名的成员了' } };
  }

  let role = roles.validRole(cur.role);
  if (patch.role !== undefined) {
    role = roles.validRole(patch.role);
    // 不允许把最后一个管理员降级，否则没人能管人和改设置
    if (cur.role === 'admin' && role !== 'admin' && adminCount() <= 1) {
      return { error: { status: 400, error: '至少要留一个管理员' } };
    }
  }

  db.tx(() => {
    db.prepare('UPDATE members SET name = ?, role = ? WHERE id = ?').run(name, role, id);
  });
  return { member: get(id) };
}

/**
 * 设/改密码。pass_ver +1，让所有旧 Cookie 立即失效。
 * @param {string} id 成员 id
 * @param {string} password 明文
 * @returns {{error?:{status:number,error:string}, member?:object, recoverCode?:string}}
 */
function setPassword(id, password) {
  const cur = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!cur) return { error: { status: 404, error: '成员不存在' } };
  const pw = String(password == null ? '' : password);
  if (pw.length < 6) return { error: { status: 400, error: '密码至少 6 位' } };

  const code = auth.makeRecoverCode();
  db.tx(() => {
    db.prepare('UPDATE members SET pass_hash = ?, pass_ver = pass_ver + 1, ' +
      'recover_code = ? WHERE id = ?')
      .run(auth.hashPassword(pw), code, id);
  });
  return { member: get(id), recoverCode: code };
}

/**
 * 删成员。他名下的物品由外键 ON DELETE SET NULL 变成「未指定」。
 * @param {string} id 成员 id
 * @returns {{error?:{status:number,error:string}, removed?:object}}
 */
function remove(id) {
  const cur = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!cur) return { error: { status: 404, error: '成员不存在' } };
  if (cur.role === 'admin' && adminCount() <= 1) {
    return { error: { status: 400, error: '至少要留一个管理员' } };
  }
  const out = rowToMember(cur);
  db.tx(() => {
    db.prepare('DELETE FROM members WHERE id = ?').run(id);
  });
  return { removed: out };
}

/**
 * 记一次「最近出现」。
 * @param {string} id 成员 id
 */
function touch(id) {
  if (!id) return;
  db.prepare('UPDATE members SET last_seen_at = ? WHERE id = ?').run(nowISO(), id);
}

/**
 * 管理员人数。
 * @returns {number}
 */
function adminCount() {
  const row = db.prepare("SELECT COUNT(*) AS c FROM members WHERE role = 'admin'").get();
  return Number(row ? row.c : 0);
}

module.exports = {
  count,
  list,
  get,
  getAuth,
  checkPassword,
  create,
  update,
  setPassword,
  remove,
  touch,
  adminCount
};
