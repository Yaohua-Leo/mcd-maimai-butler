"use strict";
const crypto = require('node:crypto');
const { stateError } = require('./state-store');
const { defaultProduct, parseQuote, yuan, money } = require('./quote');
const QUOTE_TTL = 5 * 60 * 1000;
const CHECKOUT_TTL = 24 * 60 * 60 * 1000;
const ORDER_TTL = 30 * 24 * 60 * 60 * 1000;
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const STATUS = { '1': '待付款', '2': '已付款 · 配餐中', '4': '配送中', '6': '已完成', '7': '已取消', '8': '已评价', '10': '餐厅配餐中' };
const STATUS_LABELS = Object.freeze({
  '待支付': '1', '待付款': '1', '订单待支付': '1', '订单待付款': '1',
  '已支付': '2', '已付款': '2', '配餐中': '2', '配餐中-已支付': '2', '已付款·配餐中': '2',
  '配送中': '4', '订单配送中': '4',
  '已完成': '6', '订单已完成': '6',
  '已取消': '7', '订单已取消': '7',
  '已评价': '8', '订单已评价': '8',
  '餐厅配餐中': '10', '餐厅确认配餐中': '10', '配餐中-餐厅确认配餐中': '10'
});
function normalizeOrderStatus(data) {
  const decode = (value, allowCode) => {
    if (!['string', 'number'].includes(typeof value)) return '';
    const text = String(value).trim().replace(/\s+/g, '');
    if (allowCode && Object.prototype.hasOwnProperty.call(STATUS, text)) return text;
    return Object.prototype.hasOwnProperty.call(STATUS_LABELS, text) ? STATUS_LABELS[text] : '';
  };
  // Live MCP orderStatus is often a Chinese label. The separate numeric `status`
  // uses a different namespace (observed: 10=unpaid, 40=completed); do not guess it.
  return decode(data?.orderStatus, true) || decode(data?.status, false);
}
const CONFIRM_TTL = 60000;
function safePaymentUrl(value, hosts) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return null;
    return hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : null;
  } catch (_) { return null; }
}
function orderView(data, expectedId, timestamp) {
  if (!data || String(data.orderId) !== String(expectedId)) throw stateError('order_mismatch', '官方订单信息暂不可核实，请在麦当劳官方端查看');
  const status = normalizeOrderStatus(data);
  return { orderId: String(data.orderId), status, statusText: STATUS[status] || '状态待核实',
    total: money(yuan(data.realTotalAmount)), totalCents: yuan(data.realTotalAmount),
    storeName: String(data.storeName || ''), storeAddress: String(data.storeAddress || ''),
    createdAt: String(data.createTime || ''), expirePayTime: String(data.expirePayTime || ''),
    pickupCode: String(data.pickupCode || ''), takeWay: String(data.takeWay || ''), checkedAt: timestamp,
    items: (data.orderProductList || []).map(row => ({ name: String(row.productName || ''), quantity: Number(row.quantity) || 0 })) };
}
function officialTime(value) {
  if (typeof value !== 'string') return NaN;
  const text = value.replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : text + '+08:00');
}

function createCheckoutService({ store, conversations, readTool, writeTool, gate = () => ({ enabled: false, mode: 'disabled' }), clock = () => Date.now(), paymentHosts = ['mcd.cn', 'mcdonalds.com.cn'] }) {
  async function checkout(owner, id) {
    const record = await store.get(owner, 'checkout', id);
    if (!record) throw stateError('checkout_expired', '确认清单已过期，请返回重新算价');
    return record;
  }
  async function validPlan(owner, value) {
    const session = await conversations.read(owner, value.conversationId);
    if (session.revision !== value.conversationRevision || !session.value.canQuote) throw stateError('plan_changed', '餐品方案已变化，请重新算价');
    return session;
  }
  function publicCheckout(record, writeGate = { enabled: false, mode: 'disabled' }) {
    const value = record.value;
    // Normalize previously saved labels too; no data migration or invented state.
    const status = value.order ? normalizeOrderStatus({ orderStatus: value.order.status }) : '';
    const order = value.order ? { ...value.order, status, statusText: STATUS[status] || '状态待核实' } : null;
    const cancelState = status === '7' ? 'confirmed' : value.cancelState || '';
    return { id: record.id, revision: record.revision, state: value.state, quote: value.quote, store: value.context,
      menuTotal: value.menuTotal, budgetMax: value.budgetMax, overBudget: value.overBudget, quotedAt: value.quotedAt,
      expiresAt: value.quoteExpiresAt, expired: clock() >= value.quoteExpiresAt, needTableware: value.request.needTableware,
      gate: writeGate, sourcePlanId: value.planId, order, takeWayCode: value.takeWayCode || '',
      cancelState, recoveryMessage: status === '7' ? '' : value.recoveryMessage || '',
      recoveryCandidate: value.recoveryCandidate?.order || null,
      canPay: status === '1' && !['pending', 'unknown', 'accepted'].includes(cancelState) && Boolean(safePaymentUrl(value.paymentUrl, paymentHosts)) && order.totalCents === value.quote.totalCents
        && (!order.expirePayTime || officialTime(order.expirePayTime) > clock()),
      canCancel: status === '1' && !['pending', 'unknown', 'accepted'].includes(cancelState) && writeGate.enabled };
  }
  async function quote(owner, event) {
    const session = await conversations.read(owner, event.conversationId);
    if (session.revision !== Number(event.revision) || !session.value.canQuote) throw stateError('plan_changed', '方案已变化或尚未生成，请刷新后再算价');
    const context = session.value.context;
    if (![1, 5].includes(context.beType) || !context.storeCode || context.beType === 5 && !context.beCode) throw stateError('unsupported_channel', '当前确认清单仅支持已选门店的到店取餐');
    const plan = session.value.response.recommendation;
    if (event.planId && event.planId !== plan.id) throw stateError('plan_changed', '请先确认选用这一份推荐');
    const quantities = event.quantities && typeof event.quantities === 'object' ? event.quantities : {};
    if (Object.keys(quantities).some(code => !plan.items.some(item => item.code === code))) throw stateError('invalid_quantity', '数量清单包含未选择的餐品');
    const base = { storeCode: context.storeCode, orderType: 1, beType: context.beType, ...(context.beType === 5 ? { beCode: context.beCode } : {}) };
    const products = await Promise.all(plan.items.map(async item => {
      const detail = await readTool(owner, 'query-meal-detail', { ...base, code: item.code });
      return defaultProduct(item, detail.data, quantities[item.code] === undefined ? (item.quantity || 1) : quantities[item.code]);
    }));
    const request = { ...base, items: products.map(item => item.request), needTableware: event.needTableware === true };
    const result = await readTool(owner, 'calculate-price', request);
    const quote = parseQuote(result.data, products);
    const budgetMax = session.value.constraints.budgetMax;
    const value = { state: 'quoted', context, conversationId: session.id, conversationRevision: session.revision, planId: plan.id,
      menuTotal: plan.total, request, quote, budgetMax, overBudget: budgetMax !== null && quote.totalCents > Math.round(budgetMax * 100),
      quotedAt: new Date(clock()).toISOString(), quoteExpiresAt: clock() + QUOTE_TTL };
    const saved = await store.create(owner, 'checkout', value, { ttlMs: CHECKOUT_TTL });
    return { ok: true, checkout: publicCheckout(saved, await gate(owner)) };
  }
  async function get(owner, event) {
    const record = await checkout(owner, event.checkoutId);
    return { ok: true, checkout: publicCheckout(record, await gate(owner)) };
  }
  const output = async (owner, row, extra = {}) => ({ ok: true, checkout: publicCheckout(row, await gate(owner)), ...extra });
  async function assertGate(owner, totalCents) {
    const access = await gate(owner);
    if (!access.enabled) throw stateError('write_disabled', '当前账号尚未开放真实下单，请检查账号链接与下单权限');
    if (Number.isSafeInteger(access.maxTotalCents) && totalCents > access.maxTotalCents) throw stateError('test_amount_limit', `当前单笔上限为 ¥${money(access.maxTotalCents)}，请调整餐品`);
  }
  async function ready(owner, event) {
    const row = await checkout(owner, event.checkoutId);
    if (row.revision !== Number(event.revision)) throw stateError('version_conflict', '确认清单已更新，请刷新');
    if (row.value.state !== 'quoted') throw stateError('already_submitted', '本清单已提交，请查看订单状态');
    if (clock() >= row.value.quoteExpiresAt) throw stateError('quote_expired', '报价已过期，请重新算价');
    await validPlan(owner, row.value);
    return row;
  }
  async function prepare(owner, event) {
    const row = await ready(owner, event), value = row.value;
    await assertGate(owner, value.quote.totalCents);
    const takeWay = value.quote.takeWays.find(item => item.code === event.takeWayCode);
    if (!takeWay) throw stateError('take_way_required', '请选择官方返回的取餐方式');
    if (value.overBudget && event.acceptOverBudget !== true) throw stateError('over_budget', '实时报价超过预算，请先确认是否接受');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const saved = await store.replace(owner, 'checkout', row.id, row.revision, { ...value, takeWayCode: takeWay.code,
      confirmation: { hash: digest(nonce), expiresAt: clock() + CONFIRM_TTL, totalCents: value.quote.totalCents } }, CHECKOUT_TTL);
    return output(owner, saved, { confirmation: { nonce, expiresAt: saved.value.confirmation.expiresAt, total: value.quote.total, takeWay: takeWay.title } });
  }
  const lockId = owner => 'create_lock_' + digest(owner);
  async function release(owner, checkoutId) {
    const lock = await store.get(owner, 'operation', lockId(owner));
    if (lock?.value.checkoutId === checkoutId) await store.replace(owner, 'operation', lock.id, lock.revision, { checkoutId: null });
  }
  async function indexOrder(owner, row) {
    await store.create(owner, 'order', { checkoutId: row.id }, { id: 'order_' + digest(owner + ':' + row.id), once: true });
  }
  async function create(owner, event) {
    await assertGate(owner);
    if (event.confirmed !== true) throw stateError('confirmation_required', '请逐项核对并明确确认创建本次订单');
    let row = await checkout(owner, event.checkoutId);
    if (row.value.state !== 'quoted') return output(owner, row);
    row = await ready(owner, event);
    await assertGate(owner, row.value.quote.totalCents);
    const confirmation = row.value.confirmation;
    if (!confirmation || digest(event.nonce || '') !== confirmation.hash || clock() >= confirmation.expiresAt || confirmation.totalCents !== row.value.quote.totalCents) throw stateError('confirmation_expired', '本次确认已失效，请重新核对清单');
    const lock = await store.create(owner, 'operation', { checkoutId: null }, { id: lockId(owner), once: true });
    if (lock.value.checkoutId) throw stateError('order_pending', '有一笔订单正在提交或待核实，请先到订单页查询');
    await store.replace(owner, 'operation', lock.id, lock.revision, { checkoutId: row.id });
    let dispatched = false;
    try {
      // Refresh price before consuming approval; any change needs a new user confirmation.
      const products = row.value.quote.items.map((item, index) => ({ display: item, request: row.value.request.items[index] }));
      const fresh = parseQuote((await readTool(owner, 'calculate-price', row.value.request)).data, products);
      if (JSON.stringify(fresh) !== JSON.stringify(row.value.quote)) {
        const saved = await store.replace(owner, 'checkout', row.id, row.revision, { ...row.value, quote: fresh, confirmation: null,
          quoteExpiresAt: clock() + QUOTE_TTL, quotedAt: new Date(clock()).toISOString(), overBudget: row.value.budgetMax !== null && fresh.totalCents > Math.round(row.value.budgetMax * 100) }, CHECKOUT_TTL);
        return output(owner, saved, { priceChanged: true });
      }
      const baseline = (await readTool(owner, 'order-list', {})).data?.list;
      if (!Array.isArray(baseline)) throw stateError('order_check_unavailable', '暂时无法核对已有订单，请稍后重新确认');
      await validPlan(owner, row.value);
      if (clock() >= confirmation.expiresAt || clock() >= row.value.quoteExpiresAt) throw stateError('confirmation_expired', '核对用时较长，本次确认已过期，请重新确认');
      await assertGate(owner, row.value.quote.totalCents);
      const planKey = 'plan_order_' + digest(owner + ':' + row.value.conversationId + ':' + row.value.conversationRevision);
      const planOperation = await store.create(owner, 'operation', { checkoutId: row.id }, { id: planKey, once: true });
      if (planOperation.value.checkoutId !== row.id) return output(owner, await checkout(owner, planOperation.value.checkoutId), { existingOrder: true });
      row = await store.replace(owner, 'checkout', row.id, row.revision, { ...row.value, state: 'creating', confirmation: null,
        startedAt: clock(), baselineIds: baseline.map(item => String(item.orderId)) }, null);
      await indexOrder(owner, row);
      dispatched = true;
      const result = await writeTool(owner, 'create-order', { ...row.value.request, takeWayCode: row.value.takeWayCode });
      const orderId = result?.data?.orderId;
      if (!orderId) throw Error('missing order id');
      const order = result.data.orderDetail?.orderId ? orderView(result.data.orderDetail, orderId, new Date(clock()).toISOString())
        : { orderId: String(orderId), status: '', statusText: '已创建 · 状态待核实', total: '—', totalCents: null, items: [] };
      row = await store.replace(owner, 'checkout', row.id, row.revision, { ...row.value, state: 'created', order,
        paymentUrl: safePaymentUrl(result.data.payH5Url, paymentHosts), baselineIds: [], recoveryMessage: '' }, ORDER_TTL);
      await release(owner, row.id);
      return output(owner, row);
    } catch (error) {
      if (!dispatched) throw error;
      // The official API has no idempotency key. Never resend an uncertain write.
      try { row = await store.replace(owner, 'checkout', row.id, row.revision, { ...row.value, state: 'unknown', recoveryMessage: '提交结果待核实，请刷新查询；不会自动再次下单。' }, null); } catch (_) {}
      return output(owner, row);
    } finally { if (!dispatched) await release(owner, event.checkoutId); }
  }
  async function refresh(owner, event) {
    let row = await checkout(owner, event.checkoutId), value = row.value;
    if (value.state === 'creating' && clock() - value.startedAt < 90000) return output(owner, row);
    if (!value.order && ['creating', 'unknown'].includes(value.state)) {
      const list = (await readTool(owner, 'order-list', {})).data?.list;
      if (!Array.isArray(list)) throw stateError('order_check_unavailable', '暂时无法核对订单，请稍后刷新');
      const signature = items => JSON.stringify(items.map(item => [String(item.productCode), Number(item.quantity)]).sort((a,b) => a[0].localeCompare(b[0])));
      const matches = list.filter(item => !value.baselineIds.includes(String(item.orderId)) && String(item.storeCode) === value.context.storeCode
        && String(item.orderType) === '1' && String(item.beType) === String(value.context.beType)
        && yuan(item.realTotalAmount) === value.quote.totalCents && officialTime(item.createTime) >= value.startedAt - 30000
        && officialTime(item.createTime) <= value.startedAt + 120000 && signature(item.orderProductList || []) === signature(value.request.items));
      if (matches.length !== 1) {
        row = await store.replace(owner, 'checkout', row.id, row.revision, { ...value, state: 'unknown', recoveryCandidate: null, recoveryMessage: '尚未唯一核实本笔订单，请打开麦当劳官方 App 查看；当前不会再次提交。' }, null);
        return output(owner, row);
      }
      const candidateId = String(matches[0].orderId);
      const candidate = orderView((await readTool(owner, 'query-order', { orderId: candidateId })).data, candidateId, new Date(clock()).toISOString());
      row = await store.replace(owner, 'checkout', row.id, row.revision, { ...value, state: 'unknown', paymentUrl: null,
        recoveryCandidate: { order: candidate, expiresAt: clock() + QUOTE_TTL },
        recoveryMessage: '找到一笔时间、门店、餐品和金额匹配的官方订单。请核对并确认关联，匹配本身不能证明它就是本次提交。' }, null);
      return output(owner, row);
    }
    if (!value.order) return output(owner, row);
    const detail = (await readTool(owner, 'query-order', { orderId: value.order.orderId })).data;
    const order = orderView(detail, value.order.orderId, new Date(clock()).toISOString());
    row = await store.replace(owner, 'checkout', row.id, row.revision, { ...value, state: 'created', order, baselineIds: [],
      cancelState: order.status === '7' ? 'confirmed' : value.cancelState,
      paymentUrl: !order.status || order.status === '1' ? value.paymentUrl : null,
      recoveryMessage: order.status === '7' ? '' : ['pending', 'unknown', 'accepted'].includes(value.cancelState) ? '取消结果仍待官方确认，请稍后刷新。' : '' }, ORDER_TTL);
    await indexOrder(owner, row);
    await release(owner, row.id);
    return output(owner, row);
  }
  async function list(owner) {
    const entries = await store.list(owner, 'order', 50), ids = entries.map(entry => entry.value.checkoutId);
    const lock = await store.get(owner, 'operation', lockId(owner));
    if (lock?.value.checkoutId) ids.unshift(lock.value.checkoutId);
    const rows = await Promise.all([...new Set(ids)].map(id => store.get(owner, 'checkout', id)));
    const access = await gate(owner);
    return { ok: true, orders: rows.filter(Boolean).map(row => publicCheckout(row, access)) };
  }
  async function reconcile(owner, event) {
    const row = await checkout(owner, event.checkoutId), candidate = row.value.recoveryCandidate;
    if (row.value.order) return output(owner, row);
    if (event.confirmed !== true) throw stateError('confirmation_required', '请核对候选订单并确认关联');
    if (row.revision !== Number(event.revision) || !candidate || clock() >= candidate.expiresAt) throw stateError('confirmation_expired', '候选订单已变化或过期，请重新查询');
    const order = orderView((await readTool(owner, 'query-order', { orderId: candidate.order.orderId })).data, candidate.order.orderId, new Date(clock()).toISOString());
    const saved = await store.replace(owner, 'checkout', row.id, row.revision, { ...row.value, state: 'created', order, recoveryCandidate: null,
      paymentUrl: null, baselineIds: [], recoveryMessage: '已按你的确认关联官方订单；付款请前往麦当劳官方 App。' }, ORDER_TTL);
    await indexOrder(owner, saved); await release(owner, saved.id);
    return output(owner, saved);
  }
  async function payment(owner, event) {
    await refresh(owner, event);
    const row = await checkout(owner, event.checkoutId);
    if (!publicCheckout(row, await gate(owner)).canPay) throw stateError('payment_unavailable', '当前不能打开付款页，请核对订单状态或前往麦当劳官方 App');
    return { ok: true, url: safePaymentUrl(row.value.paymentUrl, paymentHosts) };
  }
  async function prepareCancel(owner, event) {
    await assertGate(owner);
    await refresh(owner, event);
    const row = await checkout(owner, event.checkoutId);
    if (!publicCheckout(row, await gate(owner)).canCancel) throw stateError('cancel_unavailable', '当前订单不可在这里取消，请查看官方订单状态');
    if (!['1', '2', '3', '4', '5', '-1'].includes(event.reasonCode)) throw stateError('cancel_reason_required', '请选择取消原因');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const saved = await store.replace(owner, 'checkout', row.id, row.revision, { ...row.value,
      cancelConfirmation: { hash: digest(nonce), reasonCode: event.reasonCode, expiresAt: clock() + CONFIRM_TTL } }, ORDER_TTL);
    return output(owner, saved, { confirmation: { nonce, expiresAt: saved.value.cancelConfirmation.expiresAt } });
  }
  async function cancel(owner, event) {
    await assertGate(owner);
    if (event.confirmed !== true) throw stateError('confirmation_required', '请明确确认取消这笔订单');
    let row = await checkout(owner, event.checkoutId);
    if (['pending', 'unknown', 'accepted', 'confirmed'].includes(row.value.cancelState)) return output(owner, row);
    const confirmation = row.value.cancelConfirmation;
    if (row.revision !== Number(event.revision) || !confirmation || digest(event.nonce || '') !== confirmation.hash || clock() >= confirmation.expiresAt) throw stateError('confirmation_expired', '取消确认已失效，请重新核对订单');
    const current = (await readTool(owner, 'query-order', { orderId: row.value.order.orderId })).data;
    if (orderView(current, row.value.order.orderId, '').status !== '1') throw stateError('cancel_unavailable', '订单状态已变化，请刷新后查看');
    if (clock() >= confirmation.expiresAt) throw stateError('confirmation_expired', '核对用时较长，取消确认已过期，请重新确认');
    await assertGate(owner);
    row = await store.replace(owner, 'checkout', row.id, row.revision, { ...row.value, cancelState: 'pending', cancelConfirmation: null }, ORDER_TTL);
    try {
      const result = await writeTool(owner, 'cancel-order', { orderId: row.value.order.orderId, cancelReasonCode: confirmation.reasonCode });
      const accepted = result?.data?.cancelResult;
      if (typeof accepted !== 'boolean' || String(result.data.orderId) !== row.value.order.orderId) throw Error('unknown cancellation');
      row = await store.replace(owner, 'checkout', row.id, row.revision, { ...row.value, cancelState: accepted ? 'accepted' : 'rejected',
        recoveryMessage: accepted ? '取消请求已受理，请刷新确认最终状态。' : '官方未接受取消，请刷新核对状态。' }, ORDER_TTL);
    } catch (_) {
      try { row = await store.replace(owner, 'checkout', row.id, row.revision, { ...row.value, cancelState: 'unknown', recoveryMessage: '取消结果待核实，请刷新查询；不会自动再次取消。' }, ORDER_TTL); } catch (_) {}
    }
    return output(owner, row);
  }
  return { quote, get, prepare, create, refresh, list, reconcile, payment, prepareCancel, cancel };
}

module.exports = { createCheckoutService, QUOTE_TTL, CHECKOUT_TTL, ORDER_TTL, digest, safePaymentUrl, orderView, officialTime, normalizeOrderStatus };
