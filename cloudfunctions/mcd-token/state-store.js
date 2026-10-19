"use strict";

const crypto = require('node:crypto');
const TABLE = 'maimai_agent_state';
const KINDS = new Set(['conversation', 'preferences', 'checkout', 'operation', 'order']);
function stateError(code, message) { const e = new Error(message); e.safe = true; e.code = code; return e; }
function sqlTime(date) { return date.toISOString().replace('T', ' ').replace('Z', ''); }
function parsedTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const text = String(value).replace(' ', 'T');
  const result = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : text + 'Z');
  if (!Number.isFinite(result)) throw stateError('state_unavailable', '记录有效期不可核实，请重新开始');
  return result;
}

function createStateStore({ models, seal, open, clock = () => new Date() }) {
  const run = (sql, values) => models.$runSQL(sql, values);
  const check = (owner, kind, id) => {
    if (!owner || !KINDS.has(kind) || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw stateError('invalid_state', '记录参数不正确');
  };
  const decode = row => {
    if (!row) return null;
    const expiresAt = parsedTime(row.expires_at);
    if (expiresAt !== null && expiresAt <= clock().getTime()) return null;
    let value;
    try { value = JSON.parse(open(row.encrypted_payload)); } catch (_) { throw stateError('state_unavailable', '记录暂不可读，请重新开始'); }
    return { id: row._id, kind: row.kind, revision: Number(row.revision), writeId: row.write_id, expiresAt,
      updatedAt: row.updated_at, value };
  };
  const rows = result => {
    const values = result?.data?.executeResultList;
    if (!Array.isArray(values)) throw stateError('state_unavailable', '数据服务暂不可用，请稍后重试');
    return values;
  };
  async function get(owner, kind, id) {
    check(owner, kind, id);
    const result = await run(`SELECT _id,kind,revision,write_id,encrypted_payload,expires_at,updated_at FROM \`${TABLE}\` WHERE _id={{id}} AND owner_id={{owner}} AND kind={{kind}} LIMIT 1`, { id, owner, kind });
    return decode(rows(result)[0]);
  }
  async function create(owner, kind, value, { id = `${kind}_${crypto.randomUUID()}`, ttlMs = null, once = false } = {}) {
    check(owner, kind, id);
    const timestamp = sqlTime(clock()), writeId = crypto.randomUUID();
    const expiresAt = ttlMs === null ? null : sqlTime(new Date(clock().getTime() + ttlMs));
    const expirySql = expiresAt === null ? 'NULL' : '{{expiresAt}}';
    const payload = seal(JSON.stringify(value));
    // The model SQL parameter layer coerces JS null into a zero DATETIME. Use a fixed SQL NULL literal.
    await run(`INSERT ${once ? 'IGNORE ' : ''}INTO \`${TABLE}\` (_id,_openid,owner_id,kind,revision,write_id,encrypted_payload,expires_at,created_at,updated_at) VALUES ({{id}},{{owner}},{{owner}},{{kind}},1,{{writeId}},{{payload}},${expirySql},{{timestamp}},{{timestamp}})`,
      { id, owner, kind, writeId, payload, ...(expiresAt === null ? {} : { expiresAt }), timestamp });
    const record = await get(owner, kind, id);
    if (!record) throw stateError('state_unavailable', '记录创建失败，请刷新');
    return { ...record, created: record.writeId === writeId };
  }
  async function replace(owner, kind, id, revision, value, ttlMs = null) {
    check(owner, kind, id);
    if (!Number.isSafeInteger(revision) || revision < 1) throw stateError('version_conflict', '方案版本已变化，请刷新后继续');
    const writeId = crypto.randomUUID(), payload = seal(JSON.stringify(value)), timestamp = sqlTime(clock());
    const expiresAt = ttlMs === null ? null : sqlTime(new Date(clock().getTime() + ttlMs));
    const expirySql = expiresAt === null ? 'NULL' : '{{expiresAt}}';
    await run(`UPDATE \`${TABLE}\` SET revision={{nextRevision}},write_id={{writeId}},encrypted_payload={{payload}},expires_at=${expirySql},updated_at={{timestamp}} WHERE _id={{id}} AND owner_id={{owner}} AND kind={{kind}} AND revision={{revision}} AND (expires_at <=> NULL OR expires_at>{{timestamp}})`,
      { id, owner, kind, revision, nextRevision: revision + 1, writeId, payload, ...(expiresAt === null ? {} : { expiresAt }), timestamp });
    const record = await get(owner, kind, id);
    if (!record || record.writeId !== writeId) throw stateError('version_conflict', '方案已在另一请求中更新，请刷新后继续');
    return record;
  }
  async function list(owner, kind, limit = 20) {
    if (!owner || !KINDS.has(kind)) throw stateError('invalid_state', '记录参数不正确');
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const result = await run(`SELECT _id,kind,revision,write_id,encrypted_payload,expires_at,updated_at FROM \`${TABLE}\` WHERE owner_id={{owner}} AND kind={{kind}} AND (expires_at <=> NULL OR expires_at>{{timestamp}}) ORDER BY updated_at DESC LIMIT ${safeLimit}`,
      { owner, kind, timestamp: sqlTime(clock()) });
    return rows(result).map(decode).filter(Boolean);
  }
  async function remove(owner, kind, id) {
    check(owner, kind, id);
    await run(`DELETE FROM \`${TABLE}\` WHERE _id={{id}} AND owner_id={{owner}} AND kind={{kind}}`, { id, owner, kind });
  }
  async function clearKind(owner, kind) {
    if (!owner || !KINDS.has(kind)) throw stateError('invalid_state', '记录参数不正确');
    await run(`DELETE FROM \`${TABLE}\` WHERE owner_id={{owner}} AND kind={{kind}}`, { owner, kind });
  }
  return { get, create, replace, list, remove, clearKind };
}

module.exports = { createStateStore, stateError, sqlTime };
