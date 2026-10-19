"use strict";
const { stateError } = require('./state-store');
function cents(value, required = false) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (required) throw stateError('invalid_quote', '官方报价金额不完整，请重新算价');
  return null;
}
function yuan(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}
function money(value) { return value === null ? '—' : (value / 100).toFixed(2); }
function safeQuantity(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10) throw stateError('invalid_quantity', '每种餐品数量需为 1 到 10');
  return value;
}
function defaultModification(modification) {
  const values = [];
  for (const group of modification?.items || []) {
    const options = Array.isArray(group.values) ? group.values : [];
    const chosen = options.filter(option => Number(option.selectedQuantity) > 0);
    if (Number(group.minValues || 0) > chosen.length) throw stateError('specification_required', '餐品缺少默认特制，请在官方端确认规格');
    for (const option of options) {
      const selected = Number(option.selectedQuantity) > 0;
      const key = selected ? option.selectedKey : option.unselectedKey;
      if (!key) { if (selected) throw stateError('specification_required', '餐品默认特制信息不完整'); continue; }
      const quantity = Number(option.selectedQuantity || 0);
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 10 || !option.code) throw stateError('specification_required', '餐品默认特制数量不正确');
      values.push({ code: String(option.code), key: String(key), quantity });
    }
  }
  return values.length ? { values } : undefined;
}
function defaultProduct(item, detail, quantity) {
  if (!detail || String(detail.code) !== String(item.code)) throw stateError('specification_required', '未能确认餐品的默认规格');
  const product = { productCode: String(item.code), quantity: safeQuantity(quantity) };
  const modification = defaultModification(detail.modification);
  if (modification) product.modification = modification;
  const defaults = [];
  if (Array.isArray(detail.rounds) && detail.rounds.length) {
    product.roundList = detail.rounds.map(round => {
      const chosen = (round.choices || []).filter(choice => Number(choice.isDefault) === 1);
      if (!chosen.length || round.id === undefined) throw stateError('specification_required', '套餐缺少明确的默认搭配，请重新选餐');
      const comboItemList = chosen.map(choice => {
        const child = { code: String(choice.code || ''), quantity: safeQuantity(choice.quantity === undefined ? 1 : Number(choice.quantity)) };
        if (!child.code) throw stateError('specification_required', '套餐子项编码缺失');
        const modified = defaultModification(choice.modification);
        if (modified) child.modification = modified;
        defaults.push(String(choice.name || '默认子项'));
        return child;
      });
      return { round: String(round.id), comboItemList };
    });
  }
  return { request: product, display: { code: String(item.code), name: String(detail.name || item.name), quantity: product.quantity,
    specification: defaults.length ? defaults.join('、') : '官方默认规格', supportModify: detail.supportModify === true } };
}
function parseQuote(data, products) {
  if (!data || typeof data !== 'object') throw stateError('invalid_quote', '官方报价为空，请重新算价');
  const totalCents = cents(data.price, true);
  const listed = Array.isArray(data.productList) ? data.productList : [];
  if (listed.length !== products.length) throw stateError('quote_mismatch', '官方报价餐品与清单不一致，请重新选餐');
  const seen = new Set();
  const items = products.map(product => {
    const row = listed.find(item => String(item.productCode) === product.request.productCode);
    if (!row || Number(row.quantity) !== product.request.quantity || seen.has(String(row.productCode))) throw stateError('quote_mismatch', '官方报价数量与清单不一致');
    seen.add(String(row.productCode));
    return { ...product.display, officialName: String(row.productName || product.display.name),
      subtotalCents: cents(row.subtotal, true), subtotal: money(cents(row.subtotal, true)), originalSubtotal: money(cents(row.originalSubtotal)) };
  });
  const takeWays = (Array.isArray(data.takeWayList) ? data.takeWayList : []).filter(item => item && item.code && item.title)
    .map(item => ({ code: String(item.code), title: String(item.title).slice(0, 80), subtitle: String(item.subtitle || '').slice(0, 160) }));
  if (!takeWays.length || new Set(takeWays.map(item => item.code)).size !== takeWays.length) throw stateError('invalid_quote', '官方没有返回可用的取餐方式');
  return { totalCents, total: money(totalCents), original: money(cents(data.originalPrice)), productTotal: money(cents(data.productPrice)),
    discount: money(cents(data.discount)), packing: money(cents(data.packingPrice)), delivery: money(cents(data.deliveryPrice)),
    tableware: money(cents(data.tablewarePrice)), items, takeWays, source: '麦当劳 MCP calculate-price', currency: 'CNY' };
}
module.exports = { cents, yuan, money, safeQuantity, defaultModification, defaultProduct, parseQuote };
