const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCheckoutService, safePaymentUrl, officialTime, normalizeOrderStatus } = require('../cloudfunctions/mcd-token/checkout');
const { defaultProduct, parseQuote, yuan } = require('../cloudfunctions/mcd-token/quote');
const { memoryState } = require('./helpers/memory-state.cjs');
const { createOrderAccess } = require('../cloudfunctions/mcd-token/order-access');
async function setup(enabled = true, gateOverride) {
  let time = Date.parse('2026-10-17T04:00:00Z'), price = 2500, status = '1', rawStatus, orders = [], writeFailure = false, cancelResult = true, limit = 10000, expirePayTime = '', readHook = async () => {};
  const store = memoryState(() => time), calls = [];
  const session = await store.create('u', 'conversation', { canQuote: true, context: { storeCode: 'store1', storeName: '测试餐厅', beType: 1 },
    constraints: { budgetMax: 30 }, response: { recommendation: { id: 'p1', total: '25.00', items: [{ code: 'burger', name: '汉堡', quantity: 1 }] } } });
  const quoteData = args => ({ price, originalPrice: price, productPrice: price, packingPrice: 0, deliveryPrice: 0, tablewarePrice: 0, discount: 0,
    productList: args.items.map(item => ({ productCode: item.productCode, productName: '汉堡', quantity: item.quantity, subtotal: price, originalSubtotal: price })),
    takeWayList: [{ code: 'take', title: '到店自取' }] });
  const detail = id => ({ orderId: id, orderStatus: status, status: rawStatus, expirePayTime, realTotalAmount: '25.00', storeName: '测试餐厅', orderProductList: [{ productName: '汉堡', quantity: 1 }] });
  const readTool = async (owner, name, args) => {
    calls.push({ name, args });
    await readHook(name);
    if (name === 'query-meal-detail') return { data: { code: args.code, name: '汉堡' } };
    if (name === 'calculate-price') return { data: quoteData(args) };
    if (name === 'order-list') return { data: { list: orders } };
    if (name === 'query-order') return { data: detail(args.orderId) };
    throw Error('unexpected read ' + name);
  };
  const writeTool = async (owner, name, args) => {
    calls.push({ name, args });
    if (writeFailure) throw Error('synthetic timeout');
    if (name === 'create-order') return { data: { orderId: 'official1', orderDetail: detail('official1'), payH5Url: 'https://pay.mcd.cn/synthetic' } };
    if (name === 'cancel-order') return { data: { cancelResult, orderId: args.orderId } };
    throw Error('unexpected write ' + name);
  };
  const service = createCheckoutService({ store, conversations: { read: async (owner, id) => { const row = await store.get(owner, 'conversation', id); if (!row) throw Error('missing session'); return row; } },
    readTool, writeTool, gate: gateOverride || (async () => ({ enabled, mode: enabled ? 'test' : 'disabled', maxTotalCents: limit })), clock: () => time });
  const quoted = await service.quote('u', { conversationId: session.id, revision: 1 });
  const prepare = (checkout = quoted.checkout) => service.prepare('u', { checkoutId: checkout.id, revision: checkout.revision, takeWayCode: 'take' });
  const submit = result => service.create('u', { checkoutId: result.checkout.id, revision: result.checkout.revision, nonce: result.confirmation.nonce, confirmed: true });
  return { service, store, calls, session, quoted, prepare, submit, advance: ms => time += ms, setPrice: n => price = n, setStatus: s => status = s,
    setOrders: x => orders = x, failWrites: () => writeFailure = true, rejectCancel: () => cancelResult = false,
    setEnabled: x => enabled = x, setLimit: x => limit = x, setRawStatus: x => rawStatus = x, setPayExpiry: x => expirePayTime = x, onRead: fn => readHook = fn };
}

test('live Chinese status labels are normalized without confusing the separate raw numeric status', () => {
  assert.equal(normalizeOrderStatus({ orderStatus: '订单已完成', status: '40' }), '6');
  assert.equal(normalizeOrderStatus({ orderStatus: '待支付', status: '10' }), '1');
  assert.equal(normalizeOrderStatus({ orderStatus: ' 订单已取消 ' }), '7');
  assert.equal(normalizeOrderStatus({ status: '已取消' }), '7');
  assert.equal(normalizeOrderStatus({ orderStatus: 7 }), '7');
  for (const detail of [{ status: '10' }, { status: '40' }, { orderStatus: '取消处理中' }, { orderStatus: '取消失败' }, { orderStatus: '999' }, { orderStatus: 'toString' }]) assert.equal(normalizeOrderStatus(detail), '');
});

test('real-style unpaid labels retain the existing official payment link after refresh', async () => {
  const s = await setup(); s.setStatus('待支付'); s.setRawStatus('10');
  const created = await s.submit(await s.prepare());
  assert.equal(created.checkout.order.status, '1'); assert.equal(created.checkout.canPay, true);
  const refreshed = await s.service.refresh('u', { checkoutId: created.checkout.id });
  assert.equal(refreshed.checkout.order.statusText, '待付款'); assert.equal(refreshed.checkout.canPay, true);
  assert.equal((await s.service.payment('u', { checkoutId: created.checkout.id })).url, 'https://pay.mcd.cn/synthetic');
  assert.equal(s.calls.filter(call => call.name === 'create-order').length, 1);
});

test('an official-app cancellation becomes confirmed through a read alone', async () => {
  const s = await setup(), created = await s.submit(await s.prepare());
  s.setStatus('订单已取消');
  const result = await s.service.refresh('u', { checkoutId: created.checkout.id });
  assert.equal(result.checkout.order.statusText, '已取消'); assert.equal(result.checkout.cancelState, 'confirmed');
  assert.equal(result.checkout.recoveryMessage, ''); assert.equal(result.checkout.canPay, false); assert.equal(result.checkout.canCancel, false);
  assert.equal(s.calls.filter(call => call.name === 'cancel-order').length, 0);
});

test('an unknown status disables payment without destroying the encrypted link needed after a later verified read', async () => {
  const s = await setup(), created = await s.submit(await s.prepare());
  s.setStatus('取消处理中');
  const pending = await s.service.refresh('u', { checkoutId: created.checkout.id });
  assert.equal(pending.checkout.order.statusText, '状态待核实'); assert.equal(pending.checkout.canPay, false); assert.equal(pending.checkout.canCancel, false);
  s.setStatus('待支付');
  assert.equal((await s.service.refresh('u', { checkoutId: created.checkout.id })).checkout.canPay, true);
});

test('previously stored Chinese cancellation labels are displayed correctly without a data migration', async () => {
  const s = await setup(), created = await s.submit(await s.prepare());
  const row = await s.store.get('u', 'checkout', created.checkout.id);
  await s.store.replace('u', 'checkout', row.id, row.revision, { ...row.value, order: { ...row.value.order, status: '订单已取消', statusText: '状态待核实' }, cancelState: 'unknown', recoveryMessage: '取消结果待核实' });
  const result = await s.service.get('u', { checkoutId: row.id });
  assert.equal(result.checkout.order.statusText, '已取消'); assert.equal(result.checkout.cancelState, 'confirmed'); assert.equal(result.checkout.recoveryMessage, '');
  assert.equal(result.checkout.canPay, false); assert.equal(result.checkout.canCancel, false);
});
test('official cent quote keeps quantities/specifications and does not create an order', async () => {
  const s = await setup(); assert.equal(s.quoted.checkout.quote.total, '25.00');
  assert.equal(s.calls.some(c => c.name === 'create-order'), false);
  await assert.rejects(s.service.quote('u', { conversationId: s.session.id, revision: 1, quantities: { burger: 0 } }), /1 到 10/);
  await assert.rejects(s.service.quote('u', { conversationId: s.session.id, revision: 1, quantities: { forged: 1 } }), /未选择/);
});
test('default modifications include deselected keys and explicit combo defaults only', () => {
  const product = defaultProduct({ code: 'a' }, { code: 'a', modification: { items: [{ values: [
    { code: 'sugar', selectedQuantity: 1, selectedKey: 'on' }, { code: 'ice', selectedQuantity: 0, unselectedKey: 'off' }
  ] }] }, rounds: [{ id: '1', choices: [{ code: 'b', name: '默认配餐', isDefault: 1 }, { code: 'c', isDefault: 0 }] }] }, 2);
  assert.deepEqual(product.request.modification.values, [{ code: 'sugar', key: 'on', quantity: 1 }, { code: 'ice', key: 'off', quantity: 0 }]);
  assert.equal(product.request.roundList[0].comboItemList.length, 1);
  assert.throws(() => defaultProduct({ code: 'a' }, { code: 'a', rounds: [{ id: '1', choices: [] }] }, 1), /默认搭配/);
});
test('money parsers distinguish cent integers from yuan strings and reject missing totals', () => {
  assert.equal(yuan('25.10'), 2510); assert.equal(yuan('25.111'), null); assert.equal(yuan(''), null);
  assert.throws(() => parseQuote({ price: '25.00' }, []), /金额/);
  assert.throws(() => parseQuote({ price: 2500, productList: [] }, [{ request: { productCode: 'x', quantity: 1 } }]), /不一致/);
});
test('writes stay disabled by default even with confirmed=true', async () => {
  const s = await setup(false);
  await assert.rejects(s.prepare(), /尚未开放/);
  await assert.rejects(s.service.create('u', { checkoutId: s.quoted.checkout.id, confirmed: true }), /尚未开放/);
  assert.equal(s.calls.filter(c => c.name === 'create-order').length, 0);
});
test('nonce, explicit confirmation, owner, plan version, expiry and budget are enforced', async () => {
  const s = await setup(), p = await s.prepare(), id = p.checkout.id;
  await assert.rejects(s.service.create('u', { checkoutId: id }), /明确确认/);
  await assert.rejects(s.service.create('u', { checkoutId: id, revision: p.checkout.revision, confirmed: true, nonce: 'wrong' }), /失效/);
  await assert.rejects(s.service.get('other', { checkoutId: id }), /过期/);
  s.advance(61000); await assert.rejects(s.submit(p), /失效/);
  s.advance(300000); await assert.rejects(s.prepare(p.checkout), /过期/);
  const b = await setup(); b.setPrice(3500);
  const q = await b.service.quote('u', { conversationId: b.session.id, revision: 1 });
  assert.equal(q.checkout.overBudget, true); await assert.rejects(b.prepare(q.checkout), /超过预算/);
  await b.store.replace('u', 'conversation', b.session.id, 1, b.session.value);
  await assert.rejects(b.prepare(q.checkout), /已变化/);
});
test('price changes invalidate the confirmation without writing', async () => {
  const s = await setup(), p = await s.prepare(); s.setPrice(2600);
  const result = await s.submit(p); assert.equal(result.priceChanged, true); assert.equal(result.checkout.quote.total, '26.00');
  assert.equal(s.calls.filter(c => c.name === 'create-order').length, 0);
  await assert.rejects(s.submit(p), /更新/);
});
test('repeated and concurrent create confirmations cause exactly one official write', async () => {
  const s = await setup(), p = await s.prepare();
  const results = await Promise.allSettled([s.submit(p), s.submit(p)]);
  assert.ok(results.some(r => r.status === 'fulfilled' && r.value.checkout.state === 'created'));
  await s.submit(p); assert.equal(s.calls.filter(c => c.name === 'create-order').length, 1);
  const list = await s.service.list('u'); assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0].canPay, true); assert.equal(Object.hasOwn(list.orders[0], 'paymentUrl'), false);
  assert.equal((await s.service.list('other')).orders.length, 0);
});
test('a fresh quote for the same plan resolves to its existing order', async () => {
  const s = await setup(); const created = await s.submit(await s.prepare());
  const q = await s.service.quote('u', { conversationId: s.session.id, revision: 1 });
  const duplicate = await s.submit(await s.prepare(q.checkout));
  assert.equal(duplicate.existingOrder, true); assert.equal(duplicate.checkout.id, created.checkout.id);
  assert.equal(s.calls.filter(c => c.name === 'create-order').length, 1);
});
test('timeout preserves an unresolved operation, rejects other submissions, and never retries write', async () => {
  const s = await setup(), p = await s.prepare(); s.failWrites();
  const unknown = await s.submit(p); assert.equal(unknown.checkout.state, 'unknown');
  await s.submit(p); const q = await s.service.quote('u', { conversationId: s.session.id, revision: 1 });
  await assert.rejects(s.submit(await s.prepare(q.checkout)), /待核实/);
  const result = await s.service.refresh('u', { checkoutId: unknown.checkout.id });
  assert.equal(result.checkout.state, 'unknown'); assert.equal(s.calls.filter(c => c.name === 'create-order').length, 1);
});
test('unique matching order remains a candidate until the user confirms association', async () => {
  const s = await setup(), p = await s.prepare(); s.failWrites(); await s.submit(p);
  s.setOrders([{ orderId: 'official1', storeCode: 'store1', beType: '1', orderType: '1', realTotalAmount: '25.00', createTime: '2026-10-17 12:00:01', orderProductList: [{ productCode: 'burger', quantity: 1 }] }]);
  const candidate = await s.service.refresh('u', { checkoutId: p.checkout.id });
  assert.equal(candidate.checkout.state, 'unknown'); assert.equal(candidate.checkout.order, null); assert.equal(candidate.checkout.recoveryCandidate.orderId, 'official1');
  await assert.rejects(s.service.reconcile('u', { checkoutId: p.checkout.id, revision: candidate.checkout.revision }), /确认关联/);
  const recovered = await s.service.reconcile('u', { checkoutId: p.checkout.id, revision: candidate.checkout.revision, confirmed: true });
  assert.equal(recovered.checkout.state, 'created'); assert.equal(recovered.checkout.order.orderId, 'official1');
  assert.equal(recovered.checkout.canPay, false); // An order match cannot invent a payment link.
  assert.equal(officialTime('2026-10-17 12:00:01'), Date.parse('2026-10-17T04:00:01Z'));
});
test('existing or ambiguous official orders never become an asserted match', async () => {
  const s = await setup(), p = await s.prepare();
  const candidate = { orderId: 'old', storeCode: 'store1', beType: '1', orderType: '1', realTotalAmount: '25.00', createTime: '2026-10-17 12:00:01', orderProductList: [{ productCode: 'burger', quantity: 1 }] };
  s.setOrders([candidate]); s.failWrites(); await s.submit(p);
  assert.equal((await s.service.refresh('u', { checkoutId: p.checkout.id })).checkout.state, 'unknown');
  s.setOrders([{ ...candidate, orderId: 'new1' }, { ...candidate, orderId: 'new2' }]);
  assert.equal((await s.service.refresh('u', { checkoutId: p.checkout.id })).checkout.state, 'unknown');
});
test('payment requires a fresh official unpaid status and an allowlisted https host', async () => {
  const s = await setup(), created = await s.submit(await s.prepare()), id = created.checkout.id;
  assert.equal((await s.service.payment('u', { checkoutId: id })).url, 'https://pay.mcd.cn/synthetic');
  s.setStatus('2'); await assert.rejects(s.service.payment('u', { checkoutId: id }), /不能打开/);
  for (const url of ['http://pay.mcd.cn/a', 'https://mcd.cn.evil.test/a', 'https://evil-mcd.cn/a', 'https://user@pay.mcd.cn/a', 'https://pay.mcd.cn:444/a', 'javascript:alert(1)']) assert.equal(safePaymentUrl(url, ['mcd.cn']), null);
});
test('cancel requires separate approval, sends once, and confirms only official status 7', async () => {
  const s = await setup(), created = await s.submit(await s.prepare()), id = created.checkout.id;
  const p = await s.service.prepareCancel('u', { checkoutId: id, reasonCode: '1' });
  await assert.rejects(s.service.cancel('u', { checkoutId: id, revision: p.checkout.revision, nonce: p.confirmation.nonce }), /明确确认/);
  const args = { checkoutId: id, revision: p.checkout.revision, nonce: p.confirmation.nonce, confirmed: true };
  assert.equal((await s.service.cancel('u', args)).checkout.cancelState, 'accepted');
  await s.service.cancel('u', args); assert.equal(s.calls.filter(c => c.name === 'cancel-order').length, 1);
  assert.equal((await s.service.refresh('u', { checkoutId: id })).checkout.order.status, '1');
  s.setStatus('7'); const final = await s.service.refresh('u', { checkoutId: id });
  assert.equal(final.checkout.cancelState, 'confirmed'); assert.equal(final.checkout.canPay, false);
});
test('cancel timeout blocks another cancellation and suppresses payment', async () => {
  const s = await setup(), created = await s.submit(await s.prepare()), id = created.checkout.id;
  const p = await s.service.prepareCancel('u', { checkoutId: id, reasonCode: '3' }); s.failWrites();
  const args = { checkoutId: id, revision: p.checkout.revision, nonce: p.confirmation.nonce, confirmed: true };
  const result = await s.service.cancel('u', args); assert.equal(result.checkout.cancelState, 'unknown'); assert.equal(result.checkout.canPay, false);
  await s.service.cancel('u', args); assert.equal(s.calls.filter(c => c.name === 'cancel-order').length, 1);
});
test('test amount cap is enforced by the server before confirmation', async () => {
  const s = await setup(); s.setLimit(2000);
  await assert.rejects(s.prepare(), error => error.code === 'test_amount_limit');
  assert.equal(s.calls.filter(call => call.name === 'create-order').length, 0);
});
test('public access permits a 100 yuan quote and refuses 100.01 before any order write', async () => {
  const access = createOrderAccess({ env: { MCD_ORDER_WRITE_ENABLED: 'true', MCD_ORDER_ACCESS_MODE: 'bound_users' }, isBoundUser: async owner => owner === 'u' });
  for (const cents of [10000, 10001]) {
    const s = await setup(true, owner => access.read(owner)); s.setPrice(cents);
    const quote = await s.service.quote('u', { conversationId: s.session.id, revision: 1 });
    assert.equal(quote.checkout.gate.mode, 'public');
    const preparation = s.service.prepare('u', { checkoutId: quote.checkout.id, revision: quote.checkout.revision, takeWayCode: 'take', acceptOverBudget: true });
    if (cents === 10000) assert.ok((await preparation).confirmation.nonce);
    else await assert.rejects(preparation, error => error.code === 'test_amount_limit');
    assert.equal(s.calls.filter(call => call.name === 'create-order').length, 0);
  }
});
test('long preflight or revoked permission cannot send an official create after approval expires', async () => {
  for (const expired of [true, false]) {
    const s = await setup(), p = await s.prepare();
    s.onRead(async name => { if (name === 'order-list') { if (expired) s.advance(61000); else s.setEnabled(false); } });
    await assert.rejects(s.submit(p), e => e.code === (expired ? 'confirmation_expired' : 'write_disabled'));
    assert.equal(s.calls.filter(call => call.name === 'create-order').length, 0);
  }
});
test('payment links are unavailable after the official payment deadline', async () => {
  const s = await setup(); s.setPayExpiry('2026-10-17 12:00:00');
  const created = await s.submit(await s.prepare());
  assert.equal(created.checkout.canPay, false);
  await assert.rejects(s.service.payment('u', { checkoutId: created.checkout.id }), e => e.code === 'payment_unavailable');
});
