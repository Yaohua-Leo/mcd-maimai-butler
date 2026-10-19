const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStateStore } = require('../cloudfunctions/mcd-token/state-store');
function setup() {
  let time = Date.parse('2026-10-17T00:00:00Z'); const data = new Map(), calls = [];
  const models = { async $runSQL(sql, params) {
    calls.push({ sql, params });
    assert.match(sql, /owner_id/); // Every access carries the owner boundary.
    assert.doesNotMatch(sql, /IS\s+(?:NOT\s+)?NULL/i); // CloudBase parameterized SQL dialect rejects this grammar.
    assert.ok(!Object.values(params).includes(null)); // Bindings must not turn permanent expiry into a zero date.
    const p = params, row = data.get(p.id);
    if (sql.startsWith('INSERT')) {
      if (!row) data.set(p.id, { _id: p.id, owner_id: p.owner, kind: p.kind, revision: 1, write_id: p.writeId, encrypted_payload: p.payload, expires_at: p.expiresAt ?? null, updated_at: p.timestamp });
    } else if (sql.startsWith('UPDATE')) {
      if (row && row.owner_id === p.owner && row.kind === p.kind && row.revision === p.revision && (!row.expires_at || row.expires_at > p.timestamp)) Object.assign(row, { revision: p.nextRevision, write_id: p.writeId, encrypted_payload: p.payload, expires_at: p.expiresAt ?? null, updated_at: p.timestamp });
    } else if (sql.startsWith('DELETE')) {
      if (row && row.owner_id === p.owner && row.kind === p.kind) data.delete(p.id);
    } else if (sql.startsWith('SELECT')) {
      const found = [...data.values()].filter(row => row.owner_id === p.owner && row.kind === p.kind && (!p.id || row._id === p.id));
      return { data: { executeResultList: structuredClone(found) } };
    }
    return { data: { executeResultList: [] } };
  } };
  const store = createStateStore({ models, seal: x => 'sealed:' + Buffer.from(x).toString('base64'), open: x => Buffer.from(x.slice(7), 'base64').toString(), clock: () => new Date(time) });
  return { store, data, calls, advance: ms => time += ms };
}
test('production SQL store parameterizes content, encrypts payload, and isolates owner/kind', async () => {
  const { store, calls, data } = setup(), payload = { phrase: "quote ' and SQL marker -- remain data" };
  const row = await store.create('owner-a', 'conversation', payload);
  assert.deepEqual((await store.get('owner-a', 'conversation', row.id)).value, payload);
  assert.equal(await store.get('owner-b', 'conversation', row.id), null);
  assert.equal(await store.get('owner-a', 'checkout', row.id), null);
  assert.ok(!data.get(row.id).encrypted_payload.includes(payload.phrase));
  assert.ok(calls.every(call => !call.sql.includes(payload.phrase) && !call.sql.includes('owner-a')));
  await store.remove('owner-b', 'conversation', row.id); assert.ok(await store.get('owner-a', 'conversation', row.id));
});
test('production SQL revision check admits one winner under a race', async () => {
  const { store } = setup(); const row = await store.create('u', 'checkout', { state: 'quoted' });
  const results = await Promise.allSettled([store.replace('u', 'checkout', row.id, 1, { state: 'first' }), store.replace('u', 'checkout', row.id, 1, { state: 'second' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'version_conflict').length, 1);
  assert.equal((await store.get('u', 'checkout', row.id)).revision, 2);
});
test('create-once returns existing operation without changing its payload', async () => {
  const { store } = setup();
  const first = await store.create('u', 'operation', { state: 'pending' }, { id: 'stable_id', once: true });
  const second = await store.create('u', 'operation', { state: 'reset' }, { id: 'stable_id', once: true });
  assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(second.value.state, 'pending');
});
test('expired records cannot be read or revived by stale updates', async () => {
  const { store, advance, data } = setup(); const row = await store.create('u', 'conversation', {}, { ttlMs: 1000 });
  advance(1001); assert.equal(await store.get('u', 'conversation', row.id), null);
  await assert.rejects(store.replace('u', 'conversation', row.id, 1, {}), /刷新/);
  data.get(row.id).expires_at = 'not a timestamp'; await assert.rejects(store.get('u', 'conversation', row.id), /有效期/);
});
