const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOrderAccess, ownerHash } = require('../cloudfunctions/mcd-token/order-access');
const now = Date.parse('2026-10-17T04:00:00Z');
function setup(rows, env = {}, isBoundUser) {
  const queries = [];
  const service = createOrderAccess({ env, isBoundUser, clock: () => now, models: { async $runSQL(sql, params) {
    queries.push({ sql, params });
    if (rows instanceof Error) throw rows;
    return { data: { executeResultList: rows.filter(row => row.owner_hash === params.ownerHash) } };
  } } });
  return { service, queries };
}
const grant = { owner_hash: ownerHash('u'), enabled: 1, max_total_cents: 10000, expires_at: '2026-10-24 04:00:00.000' };
test('test permission is admin-owned, account-specific, expiring and capped', async () => {
  const { service, queries } = setup([grant]);
  const own = await service.read('u'); assert.equal(own.enabled, true); assert.equal(own.maxTotalCents, 10000);
  assert.equal((await service.read('other')).enabled, false);
  assert.equal(queries[0].params.ownerHash, ownerHash('u')); assert.equal(queries[0].sql.includes('u\''), false);
});
test('missing, disabled, expired or malformed permissions fail closed', async () => {
  for (const row of [null, { ...grant, enabled: 0 }, { ...grant, expires_at: '2026-10-16 04:00:00' }, { ...grant, expires_at: 'invalid' }, { ...grant, max_total_cents: -1 }, { ...grant, max_total_cents: 1000000 }]) {
    assert.equal((await setup(row ? [row] : []).service.read('u')).enabled, false);
  }
  assert.equal((await setup(new Error('synthetic database outage')).service.read('u')).enabled, false);
});
test('global kill switch overrides grants; global true alone does not grant every account', async () => {
  const closed = setup([grant], { MCD_ORDER_WRITE_ENABLED: 'false', MCD_ORDER_TEST_USERS: 'u' });
  assert.equal((await closed.service.read('u')).enabled, false); assert.equal(closed.queries.length, 0);
  assert.equal((await setup([], { MCD_ORDER_WRITE_ENABLED: 'true' }).service.read('other')).enabled, false);
  assert.equal((await setup([], { MCD_ORDER_WRITE_ENABLED: 'true', MCD_ORDER_TEST_USERS: 'u' }).service.read('u')).enabled, true);
});

const publicEnv = { MCD_ORDER_WRITE_ENABLED: 'true', MCD_ORDER_ACCESS_MODE: 'bound_users' };
test('public access requires the caller own server-confirmed binding and fixes the cap at 100 yuan', async () => {
  const checked = [];
  const { service, queries } = setup([{ ...grant, max_total_cents: 99999 }], publicEnv, async owner => { checked.push(owner); return owner === 'bound'; });
  assert.deepEqual(await service.read('bound'), { enabled: true, mode: 'public', maxTotalCents: 10000, expiresAt: null });
  assert.equal((await service.read('unbound')).reason, 'account_not_linked');
  assert.deepEqual(checked, ['bound', 'unbound']); assert.equal(queries.length, 0);
});
test('public access is rechecked and immediately stops after disconnect', async () => {
  let bound = true;
  const { service } = setup([], publicEnv, async () => bound);
  assert.equal((await service.read('u')).enabled, true);
  bound = false;
  assert.equal((await service.read('u')).enabled, false);
});
test('missing checker, non-boolean claims and binding lookup failures never open public access', async () => {
  assert.equal((await setup([], publicEnv).service.read('u')).enabled, false);
  assert.equal((await setup([], publicEnv, async () => 'true').service.read('u')).enabled, false);
  assert.equal((await setup([], publicEnv, async () => { throw new Error('synthetic outage'); }).service.read('u')).reason, 'unavailable');
});
test('public mode needs both explicit switches and cannot bypass the emergency stop', async () => {
  for (const enabled of [undefined, 'false', 'TRUE', '']) {
    const { service } = setup([grant], { ...publicEnv, MCD_ORDER_WRITE_ENABLED: enabled }, async () => { throw new Error('must not run'); });
    assert.equal((await service.read('u')).reason, 'closed');
  }
  assert.equal((await setup([grant], { ...publicEnv, MCD_ORDER_ACCESS_MODE: 'typo' }, async () => true).service.read('u')).enabled, false);
  assert.equal((await setup([], publicEnv, async () => true).service.read('')).enabled, false);
});
