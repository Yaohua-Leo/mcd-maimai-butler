"use strict";

const { stateError } = require('./state-store');
const SESSION_TTL = 2 * 60 * 60 * 1000;
const ROLES = ['main', 'side', 'drink'];
const LABELS = { main: '主食', side: '配餐', drink: '饮料' };
const SECRET_PATTERN = /(?:sk-[a-z0-9_-]{16,}|Bearer\s+\S{12,}|eyJ[a-z0-9_-]{16,}\.[a-z0-9_-]+\.|-----BEGIN .*PRIVATE KEY-----|(?:token|api[_ -]?key|password|密码)\s*[:=：]\s*\S{6,})/i;
function cleanText(value, length = 80) {
  const text = typeof value === 'string' ? value.trim().slice(0, length) : '';
  if (SECRET_PATTERN.test(text)) throw stateError('sensitive_input', '请不要在选餐要求中填写密钥、Token 或密码');
  return text;
}
function terms(value) { return [...new Set((Array.isArray(value) ? value : []).map(x => cleanText(x, 32)).filter(Boolean))].slice(0, 12); }
function roles(value) { return [...new Set((Array.isArray(value) ? value : []).filter(x => ROLES.includes(x)))]; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 5000 ? value : undefined; }
function baseConstraints(value = {}) {
  return { budgetMax: number(value.budgetMax) ?? null, mood: ['light', 'balanced', 'satisfying'].includes(value.mood) ? value.mood : 'balanced',
    exclusions: terms(value.exclusions), dietary: terms(value.dietary), preferredByRole: {}, omitRoles: [] };
}
function sanitizePatch(raw = {}) {
  const patch = { changeRoles: roles(raw.changeRoles), addExclusions: terms(raw.addExclusions), removeExclusions: terms(raw.removeExclusions),
    addDietary: terms(raw.addDietary), removeDietary: terms(raw.removeDietary), omitRoles: roles(raw.omitRoles).filter(role => role !== 'main'),
    restoreRoles: roles(raw.restoreRoles), preferredByRole: {}, goal: raw.goal === 'order_draft' ? 'order_draft' : 'recommend' };
  if (Object.hasOwn(raw, 'budgetMax') && (raw.budgetMax === null || number(raw.budgetMax) !== undefined)) patch.budgetMax = raw.budgetMax;
  if (number(raw.cheaperBy) !== undefined && raw.cheaperBy > 0) patch.cheaperBy = raw.cheaperBy;
  if (['light', 'balanced', 'satisfying'].includes(raw.mood)) patch.mood = raw.mood;
  for (const role of ROLES) if (typeof raw.preferredByRole?.[role] === 'string') patch.preferredByRole[role] = cleanText(raw.preferredByRole[role], 40);
  if (raw.needsClarification === true) patch.question = cleanText(raw.question, 160) || '请说明想修改哪一项。';
  return patch;
}
function mergeConstraints(previous, patch, plan) {
  const next = { ...baseConstraints(previous), preferredByRole: { ...(previous.preferredByRole || {}) }, omitRoles: roles(previous.omitRoles) };
  if (Object.hasOwn(patch, 'budgetMax')) next.budgetMax = patch.budgetMax;
  if (patch.cheaperBy !== undefined) {
    const total = Number(plan?.total);
    if (!plan || !Number.isFinite(total)) throw stateError('clarification_required', '请先生成一份推荐，再指定便宜多少元');
    next.budgetMax = Math.max(0, Number((total - patch.cheaperBy).toFixed(2)));
  }
  if (patch.mood) next.mood = patch.mood;
  next.exclusions = [...new Set(next.exclusions.filter(x => !patch.removeExclusions.includes(x)).concat(patch.addExclusions))];
  next.dietary = [...new Set(next.dietary.filter(x => !patch.removeDietary.includes(x)).concat(patch.addDietary))];
  for (const [role, desired] of Object.entries(patch.preferredByRole)) {
    if (desired) next.preferredByRole[role] = desired; else delete next.preferredByRole[role];
  }
  next.omitRoles = [...new Set(next.omitRoles.filter(x => !patch.restoreRoles.includes(x)).concat(patch.omitRoles))];
  const changed = new Set([...patch.changeRoles, ...Object.keys(patch.preferredByRole), ...patch.omitRoles, ...patch.restoreRoles]);
  for (const item of plan?.items || []) {
    const role = item.role || ROLES.find(role => LABELS[role] === item.type);
    if (patch.addExclusions.some(term => item.name.includes(term))) changed.add(role);
  }
  const lockedItems = {};
  if (plan && changed.size) for (const item of plan.items || []) {
    const role = item.role || ROLES.find(role => LABELS[role] === item.type);
    if (role && !changed.has(role) && !next.omitRoles.includes(role)) lockedItems[role] = item.code;
  }
  return { constraints: next, lockedItems };
}
function changesBetween(before, after) {
  if (!before) return ['已按本次要求生成推荐'];
  const changes = [];
  for (const role of ROLES) {
    const find = plan => (plan?.items || []).find(item => item.role === role || item.type === LABELS[role]);
    const a = find(before), b = find(after);
    if (!a && b) changes.push(`增加${LABELS[role]}：${b.name}`);
    else if (a && !b) changes.push(`去掉${LABELS[role]}：${a.name}`);
    else if (a && b && (a.code !== b.code || a.name !== b.name)) changes.push(`${LABELS[role]}：${a.name} → ${b.name}`);
  }
  if (String(before.total) !== String(after.total)) changes.push(`菜单合计：¥${before.total} → ¥${after.total}`);
  return changes.length ? changes : ['当前方案已符合要求，餐品保持不变'];
}
function view(record) {
  return { id: record.id, revision: record.revision, expiresAt: record.expiresAt, changes: record.value.changes || [],
    constraints: record.value.constraints, history: record.value.history || [], canQuote: record.value.canQuote === true };
}

function createConversationService({ store, parsePatch, recommend, explain, loadPreferences = async () => null }) {
  async function read(owner, id) {
    const record = await store.get(owner, 'conversation', id);
    if (!record) throw stateError('session_expired', '本轮方案已过期或不可用，请重新选餐');
    return record;
  }
  async function commit(owner, previous, value) {
    return previous ? store.replace(owner, 'conversation', previous.id, previous.revision, value, SESSION_TTL)
      : store.create(owner, 'conversation', value, { ttlMs: SESSION_TTL });
  }
  async function turn(owner, event, initialContext) {
    const message = cleanText(event.message, 240);
    if (!message) throw stateError('message_required', '请填写选餐或修改要求');
    const previous = event.conversationId ? await read(owner, event.conversationId) : null;
    if (previous && Number(event.revision) !== previous.revision) throw stateError('version_conflict', '方案已更新，请刷新后继续修改');
    const context = previous?.value.context || initialContext;
    if (!context.storeCode) return { ok: true, mode: 'store_required', question: '请先确认餐厅，再让 Agent 选餐。' };
    if (previous && initialContext.storeCode && initialContext.storeCode !== context.storeCode) throw stateError('store_changed', '餐厅已改变，请开始新一轮选餐');
    const preferences = previous ? null : await loadPreferences(owner);
    const initial = baseConstraints(preferences?.enabled ? preferences.settings : { budgetMax: 40, mood: 'balanced' });
    if (event.context?.settingsOverride === true) Object.assign(initial, baseConstraints(context.settings));
    const current = previous?.value.constraints || initial;
    const patch = sanitizePatch(await parsePatch(owner, message, { context, constraints: current, plan: previous?.value.response?.recommendation || null }));
    if (patch.question) return { ok: true, mode: 'clarifying', question: patch.question, conversation: previous ? view(previous) : null };
    const hasEdits = Object.hasOwn(patch, 'budgetMax') || patch.cheaperBy !== undefined || patch.mood || Object.keys(patch.preferredByRole).length
      || ['changeRoles', 'addExclusions', 'removeExclusions', 'addDietary', 'removeDietary', 'omitRoles', 'restoreRoles'].some(key => patch[key].length);
    if (patch.goal === 'order_draft' && previous?.value.canQuote && !hasEdits) return { ...previous.value.response, mode: 'order_draft', conversation: view(previous) };
    const { constraints, lockedItems } = mergeConstraints(current, patch, previous?.value.response?.recommendation);
    let response;
    try { response = await recommend(owner, { ...context, preferences: { ...constraints, lockedItems }, locationLabel: `${context.city} · ${context.keyword}` }); }
    catch (error) {
      if (!String(error?.message || '').startsWith('preference_conflict:')) throw error;
      const reason = error.message.slice(error.message.indexOf(':') + 1).trim();
      const value = { context, constraints, response: previous?.value.response || null, canQuote: false, changes: [], history: previous?.value.history || [] };
      const record = await commit(owner, previous, value);
      return { ok: true, mode: 'constraint_conflict', reason, question: '需要放宽预算、替换范围或其他要求吗？', conversation: view(record) };
    }
    if (!response?.ok || !response.recommendation) return response;
    const changes = changesBetween(previous?.value.response?.recommendation, response.recommendation);
    const plans = [response.recommendation, ...(response.alternatives || [])];
    const reasons = await explain(owner, plans, constraints);
    plans.forEach((plan, i) => { plan.agentReason = reasons[i] || plan.reason; });
    response.agent = { intent: constraints, explanation: plans[0].agentReason, toolCalls: response.toolCalls };
    response.agentTurn = { state: 'recommendation_ready', goal: patch.goal, writeToolsEnabled: false };
    const history = (previous?.value.history || []).concat([{ changes, total: response.recommendation.total }]).slice(-6);
    const record = await commit(owner, previous, { context, constraints, response, changes, history, canQuote: true });
    return { ...response, mode: patch.goal === 'order_draft' ? 'order_draft' : response.mode, conversation: view(record) };
  }
  async function select(owner, event) {
    const record = await read(owner, event.conversationId);
    if (record.revision !== Number(event.revision)) throw stateError('version_conflict', '方案已变化，请刷新');
    if (!record.value.canQuote) throw stateError('invalid_plan', '请先生成符合条件的推荐');
    const response = record.value.response;
    const all = [response.recommendation, ...response.alternatives];
    const chosen = all.find(plan => plan.id === event.planId);
    if (!chosen) throw stateError('invalid_plan', '此方案已失效，请重新选择');
    const changes = changesBetween(response.recommendation, chosen);
    const updated = { ...response, recommendation: chosen, alternatives: all.filter(plan => plan.id !== chosen.id),
      orderDraft: { ...response.orderDraft, id: chosen.id, items: chosen.items, total: chosen.total, nutrition: chosen.nutrition } };
    const saved = await commit(owner, record, { ...record.value, response: updated, changes,
      history: (record.value.history || []).concat([{ changes, total: chosen.total }]).slice(-6) });
    return { ...updated, conversation: view(saved) };
  }
  async function restore(owner, id) {
    const record = await read(owner, id);
    return { ...(record.value.response || {}), ok: true, mode: record.value.canQuote ? 'live_mcp' : 'constraint_conflict', conversation: view(record), store: record.value.context };
  }
  return { turn, select, restore, read };
}

module.exports = { createConversationService, sanitizePatch, mergeConstraints, baseConstraints, changesBetween, cleanText, terms, SESSION_TTL, ROLES, LABELS };
