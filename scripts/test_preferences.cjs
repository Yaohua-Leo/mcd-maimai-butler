const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memoryState } = require('./helpers/memory-state.cjs');
const { createPreferenceService } = require('../cloudfunctions/mcd-token/preferences');
const { createConversationService } = require('../cloudfunctions/mcd-token/conversation');
const settings = { budgetMax: 35, mood: 'light', exclusions: ['可乐'], dietary: ['不辣'] };
test('preferences require explicit consent, persist across service instances and isolate accounts', async () => {
  const store = memoryState(); const service = createPreferenceService({ store });
  await assert.rejects(service.save('a', { settings }), e => e.code === 'consent_required');
  const saved = await service.save('a', { consent: true, revision: 0, settings });
  assert.equal(saved.enabled, true);
  assert.deepEqual((await createPreferenceService({ store }).read('a')).settings, settings);
  assert.equal((await service.read('b')).saved, false);
  await assert.rejects(service.save('a', { consent: true, revision: 0, settings }), e => e.code === 'version_conflict');
});
test('disable stops use and invalidates inherited sessions; delete removes saved data', async () => {
  const store = memoryState(); const service = createPreferenceService({ store });
  await service.save('a', { consent: true, settings });
  await store.create('a', 'conversation', { constraints: settings });
  await store.create('b', 'conversation', { constraints: settings });
  const disabled = await service.disable('a', 1);
  assert.equal(disabled.enabled, false); assert.equal(disabled.saved, true);
  assert.equal((await store.list('a', 'conversation')).length, 0);
  assert.equal((await store.list('b', 'conversation')).length, 1);
  await assert.rejects(service.remove('a', false), e => e.code === 'confirmation_required');
  await service.remove('a', true); assert.equal((await service.read('a')).saved, false);
});
test('saved defaults apply, but current explicit text wins and disabled defaults never leak from stale client settings', async () => {
  const store = memoryState(); const prefs = createPreferenceService({ store });
  await prefs.save('a', { consent: true, settings });
  const requests = [];
  const conversation = createConversationService({ store, loadPreferences: prefs.read, parsePatch: async () => ({ budgetMax: 45 }),
    explain: async () => [], recommend: async (_, request) => {
      requests.push(request); return { ok: true, mode: 'live_mcp', recommendation: { id: 'x', items: [], total: '30' }, alternatives: [] };
    } });
  await conversation.turn('a', { message: '这次45元' }, { storeCode: 's', settings: { budgetMax: 40 } });
  assert.equal(requests[0].preferences.budgetMax, 45); assert.deepEqual(requests[0].preferences.exclusions, ['可乐']);
  await prefs.disable('a', 1);
  await conversation.turn('a', { message: '这次45元' }, { storeCode: 's', settings });
  assert.deepEqual(requests[1].preferences.exclusions, []);
});
test('saving current conversation verifies owner and revision and only copies allowed preference fields', async () => {
  const store = memoryState(); const prefs = createPreferenceService({ store });
  const session = await store.create('a', 'conversation', { constraints: { ...settings, preferredByRole: { drink: '无糖' } }, arbitrary: 'not a preference' });
  await assert.rejects(prefs.save('b', { consent: true, conversationId: session.id, conversationRevision: 1 }), e => e.code === 'version_conflict');
  const saved = await prefs.save('a', { consent: true, conversationId: session.id, conversationRevision: 1 });
  assert.deepEqual(saved.settings, settings); assert.equal(saved.settings.preferredByRole, undefined);
});
