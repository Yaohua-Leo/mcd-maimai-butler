"use strict";
const crypto = require('node:crypto');
const ownerHash = owner => crypto.createHash('sha256').update(owner).digest('hex');
const disabled = reason => ({ enabled: false, mode: 'disabled', reason, maxTotalCents: null, expiresAt: null });

function createOrderAccess({ models, env = process.env, clock = () => Date.now(), isBoundUser = async () => false }) {
  async function read(owner) {
    if (!owner || env.MCD_ORDER_WRITE_ENABLED === 'false') return disabled('closed');
    const policy = String(env.MCD_ORDER_ACCESS_MODE || 'invite');
    if (policy === 'bound_users') {
      if (env.MCD_ORDER_WRITE_ENABLED !== 'true') return disabled('closed');
      try {
        // Only a server-side binding lookup may establish eligibility. No client flags or grants can raise this cap.
        if (await isBoundUser(owner) !== true) return disabled('account_not_linked');
        return { enabled: true, mode: 'public', maxTotalCents: 10000, expiresAt: null };
      } catch (_) { return disabled('unavailable'); }
    }
    if (policy !== 'invite') return disabled('unavailable');
    const legacy = String(env.MCD_ORDER_TEST_USERS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (env.MCD_ORDER_WRITE_ENABLED === 'true' && legacy.includes(owner)) return { enabled: true, mode: 'test', maxTotalCents: 10000, expiresAt: null };
    try {
      const result = await models.$runSQL('SELECT enabled,max_total_cents,expires_at FROM `maimai_order_access` WHERE owner_hash={{ownerHash}} LIMIT 1', { ownerHash: ownerHash(owner) });
      const rows = result?.data?.executeResultList;
      if (!Array.isArray(rows)) return disabled('unavailable');
      const row = rows[0];
      if (!row || Number(row.enabled) !== 1) return disabled('not_enabled');
      const dateText = typeof row.expires_at === 'string' ? row.expires_at.replace(' ', 'T') : '';
      const expiry = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(dateText) ? dateText : dateText + 'Z');
      const max = Number(row.max_total_cents);
      if (!Number.isFinite(expiry) || expiry <= clock() || !Number.isSafeInteger(max) || max < 1 || max > 100000) return disabled('expired');
      return { enabled: true, mode: 'test', maxTotalCents: max, expiresAt: expiry };
    } catch (_) { return disabled('unavailable'); }
  }
  return { read, fingerprint: ownerHash };
}
module.exports = { createOrderAccess, ownerHash };
