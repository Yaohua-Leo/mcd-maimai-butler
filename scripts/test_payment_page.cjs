const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function setup() {
  let page; const calls = [], copied = [];
  const wx = { cloud: { callFunction: call => calls.push(call) }, setClipboardData: options => { copied.push(options.data); options.success(); }, navigateBack() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/pages/payment/index.js'), 'utf8'), { Page: value => page = value, wx });
  page.data = structuredClone(page.data); page.setData = patch => Object.assign(page.data, patch);
  return { page, calls, copied };
}
test('payment page loads only a server-approved link using internal ID', () => {
  const { page, calls } = setup(); page.onLoad({ id: 'checkout_test', url: 'https://untrusted.test' });
  assert.equal(calls[0].data.action, 'order-payment'); assert.equal(calls[0].data.checkoutId, 'checkout_test');
  assert.equal('url' in calls[0].data, false);
  calls.shift().success({ result: { ok: true, url: 'https://pay.mcd.cn/synthetic' } });
  assert.equal(page.data.url, 'https://pay.mcd.cn/synthetic'); assert.equal(page.data.loading, false);
});
test('opening and copying never assert payment success; copy requires a fresh server read', () => {
  const { page, calls, copied } = setup(); page.onLoad({ id: 'checkout_test' });
  calls.shift().success({ result: { ok: true, url: 'https://pay.mcd.cn/synthetic' } }); page.onPaymentError();
  assert.equal(page.data.url, ''); assert.equal(copied.length, 0);
  page.copyOfficialLink(); assert.equal(calls[0].data.action, 'order-payment');
  calls.shift().success({ result: { ok: true, url: 'https://pay.mcd.cn/refreshed-synthetic' } });
  assert.equal(copied[0], 'https://pay.mcd.cn/refreshed-synthetic'); assert.equal(page.data.copied, true);
  assert.equal('paid' in page.data, false);
});
test('paid/expired rejection and unload prevent copying a stale link', () => {
  const { page, calls, copied } = setup(); page.onLoad({ id: 'checkout_test' });
  calls.shift().success({ result: { ok: false, error: '当前不能打开付款页' } });
  assert.equal(page.data.url, ''); page.copyOfficialLink(); page.onUnload();
  calls.shift().success({ result: { ok: true, url: 'https://pay.mcd.cn/stale-synthetic' } });
  assert.equal(copied.length, 0);
});
