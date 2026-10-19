const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePatch, mergeConstraints, baseConstraints, createConversationService } = require('../cloudfunctions/mcd-token/conversation');
const { memoryState } = require('./helpers/memory-state.cjs');
const plan = { id: 'm-s-d', total: '38.90', items: [{ role: 'main', code: 'm', name: '麦香鸡' }, { role: 'side', code: 's', name: '小薯条' }, { role: 'drink', code: 'd', name: '可乐' }] };
test('a drink revision keeps main/side and all untouched hard constraints', () => {
  const prior = baseConstraints({ budgetMax: 40, exclusions: ['辣'], dietary: ['不辣'] });
  const patch = sanitizePatch({ changeRoles: ['drink'], preferredByRole: { drink: '无糖' } });
  const result = mergeConstraints(prior, patch, plan);
  assert.deepEqual(result.lockedItems, { main: 'm', side: 's' });
  assert.equal(result.constraints.budgetMax, 40); assert.deepEqual(result.constraints.exclusions, ['辣']);
  assert.equal(result.constraints.preferredByRole.drink, '无糖');
});
test('relative price reduction uses last real total and explicit new budget replaces old value', () => {
  const prior = baseConstraints({ budgetMax: 40 });
  assert.equal(mergeConstraints(prior, sanitizePatch({ cheaperBy: 5 }), plan).constraints.budgetMax, 33.9);
  assert.equal(mergeConstraints(prior, sanitizePatch({ budgetMax: 50 }), plan).constraints.budgetMax, 50);
  assert.equal(mergeConstraints(prior, sanitizePatch({ budgetMax: null }), plan).constraints.budgetMax, null);
  assert.throws(() => mergeConstraints(prior, sanitizePatch({ cheaperBy: 5 }), null), /先生成/);
});
test('exclusions are additive unless explicitly removed; omitted drinks preserve main and side', () => {
  const prior = baseConstraints({ exclusions: ['可乐'] });
  const result = mergeConstraints(prior, sanitizePatch({ addExclusions: ['辣'], omitRoles: ['drink'] }), plan);
  assert.deepEqual(result.constraints.exclusions, ['可乐', '辣']); assert.deepEqual(result.constraints.omitRoles, ['drink']);
  assert.deepEqual(result.lockedItems, { main: 'm', side: 's' });
  assert.deepEqual(mergeConstraints(result.constraints, sanitizePatch({ removeExclusions: ['可乐'], restoreRoles: ['drink'] }), plan).constraints.exclusions, ['辣']);
});
function harness(patches) {
  const store = memoryState(); const requests = [];
  const service = createConversationService({ store, parsePatch: async () => patches.shift() || {},
    recommend: async (_, request) => { requests.push(request); return { ok: true, mode: 'live_mcp', recommendation: structuredClone(plan), alternatives: [{ ...structuredClone(plan), id: 'alt', total: '35.00' }], orderDraft: { items: plan.items, total: plan.total } }; },
    explain: async () => ['测试理由'] });
  const context = { storeCode: 'store-a', storeName: '测试店', beType: 1, settings: { budgetMax: 40 } };
  return { store, requests, service, context };
}
test('multi-turn state stays server-owned, preserves store, and rejects stale versions and other owners', async () => {
  const h = harness([{ addExclusions: ['辣'] }, { changeRoles: ['drink'], preferredByRole: { drink: '无糖' } }]);
  const first = await h.service.turn('owner-a', { message: '40元不要辣', context: {} }, h.context);
  const second = await h.service.turn('owner-a', { message: '饮料换无糖', conversationId: first.conversation.id, revision: 1 }, { storeCode: 'store-a' });
  assert.equal(second.conversation.revision, 2); assert.equal(h.requests[1].storeCode, 'store-a');
  assert.deepEqual(h.requests[1].preferences.lockedItems, { main: 'm', side: 's' });
  assert.deepEqual(h.requests[1].preferences.exclusions, ['辣']);
  await assert.rejects(h.service.turn('owner-a', { message: '继续', conversationId: first.conversation.id, revision: 1 }, h.context), e => e.code === 'version_conflict');
  await assert.rejects(h.service.restore('owner-b', first.conversation.id), e => e.code === 'session_expired');
});
test('selecting an alternative updates the server draft and revision', async () => {
  const h = harness([{}]); const first = await h.service.turn('owner-a', { message: '选餐' }, h.context);
  const selected = await h.service.select('owner-a', { conversationId: first.conversation.id, revision: 1, planId: 'alt' });
  assert.equal(selected.conversation.revision, 2); assert.equal(selected.orderDraft.total, '35.00');
});
test('credentials are rejected before model call or persistence', async () => {
  const h = harness([{}]);
  await assert.rejects(h.service.turn('owner-a', { message: 'token=synthetic-test-secret-123456' }, h.context), e => e.code === 'sensitive_input');
  assert.equal(h.store.values.size, 0); assert.equal(h.requests.length, 0);
});
test('an order request only returns a draft and never invokes a write tool', async () => {
  const h = harness([{}, { goal: 'order_draft' }]);
  const first = await h.service.turn('owner-a', { message: '选餐' }, h.context);
  const result = await h.service.turn('owner-a', { message: '帮我点这个', conversationId: first.conversation.id, revision: 1 }, h.context);
  assert.equal(result.mode, 'order_draft'); assert.equal(h.requests.length, 1);
});
test('a combined revision and order request applies the changes before returning a draft', async () => {
  const h = harness([{}, { goal: 'order_draft', changeRoles: ['drink'], preferredByRole: { drink: '无糖' } }]);
  const first = await h.service.turn('owner-a', { message: '选餐' }, h.context);
  const result = await h.service.turn('owner-a', { message: '饮料换无糖然后帮我点', conversationId: first.conversation.id, revision: 1 }, h.context);
  assert.equal(result.mode, 'order_draft'); assert.equal(result.conversation.revision, 2);
  assert.equal(h.requests[1].preferences.preferredByRole.drink, '无糖'); assert.equal(h.requests.length, 2);
});
