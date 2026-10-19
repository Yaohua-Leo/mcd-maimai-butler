"use strict";
const crypto = require('node:crypto');
const { baseConstraints } = require('./conversation');
const { stateError } = require('./state-store');
const preferenceId = owner => `preferences_${crypto.createHash('sha256').update(owner).digest('hex').slice(0, 40)}`;
function createPreferenceService({ store, clock = () => new Date() }) {
  const get = owner => store.get(owner, 'preferences', preferenceId(owner));
  const publicValue = record => record ? { saved: true, enabled: record.value.enabled === true, revision: record.revision,
    settings: record.value.settings, savedAt: record.value.savedAt } : { saved: false, enabled: false, revision: 0, settings: null };
  async function read(owner) { return publicValue(await get(owner)); }
  async function save(owner, event) {
    if (event.consent !== true) throw stateError('consent_required', '请先同意保存选餐偏好');
    let input = event.settings;
    if (event.conversationId) {
      const conversation = await store.get(owner, 'conversation', event.conversationId);
      if (!conversation || conversation.revision !== Number(event.conversationRevision)) throw stateError('version_conflict', '本轮方案已变化，请刷新后再保存偏好');
      input = conversation.value.constraints;
    }
    if (!input || typeof input !== 'object') throw stateError('invalid_preferences', '请先填写需要保存的偏好');
    if (input.budgetMax !== null && input.budgetMax !== undefined && (typeof input.budgetMax !== 'number' || !Number.isFinite(input.budgetMax) || input.budgetMax < 0 || input.budgetMax > 5000)) throw stateError('invalid_preferences', '预算需要是 0 到 5000 之间的数字，或留空不限');
    const { budgetMax, mood, exclusions, dietary } = baseConstraints(input);
    const value = { enabled: true, consentVersion: 1, consentedAt: clock().toISOString(), savedAt: clock().toISOString(), settings: { budgetMax, mood, exclusions, dietary } };
    const previous = await get(owner);
    if (previous && previous.revision !== Number(event.revision)) throw stateError('version_conflict', '偏好已在另一页面修改，请重新读取');
    const saved = previous ? await store.replace(owner, 'preferences', previous.id, previous.revision, value)
      : await store.create(owner, 'preferences', value, { id: preferenceId(owner), once: true });
    if (saved.created === false) throw stateError('version_conflict', '偏好已在另一页面保存，请重新读取');
    return publicValue(saved);
  }
  async function disable(owner, revision) {
    const previous = await get(owner);
    if (previous && previous.revision !== Number(revision)) throw stateError('version_conflict', '偏好已变化，请重新读取');
    const saved = previous ? await store.replace(owner, 'preferences', previous.id, previous.revision, { ...previous.value, enabled: false }) : null;
    await store.clearKind(owner, 'conversation');
    return publicValue(saved);
  }
  async function remove(owner, confirmed) {
    if (confirmed !== true) throw stateError('confirmation_required', '请确认删除已保存的偏好');
    await store.remove(owner, 'preferences', preferenceId(owner));
    await store.clearKind(owner, 'conversation');
    return publicValue(null);
  }
  return { read, save, disable, remove };
}
module.exports = { createPreferenceService, preferenceId };
