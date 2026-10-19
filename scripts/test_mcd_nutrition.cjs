const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const n = require('../cloudfunctions/mcd-token/nutrition');
const fixture = require('./fixtures/mcd-nutrition-20261017.json');
const resolve = (items, raw = fixture.nutrition, fn = async code => fixture.details[code]) => n.resolveNutrition(items, raw, fn);
const menu = code => fixture.menu.find(item => item.code === code);

test('observed menu names require details; known serving resolves all three nutrients', async () => {
  const items = ['1100', '4810', '3010'].map(menu); const calls = [];
  const resolved = await resolve(items, fixture.nutrition, async code => { calls.push(code); return fixture.details[code]; });
  const totals = n.summarizeNutrition(items.map(item => resolved.get(item.code)));
  assert.equal(totals.energyKcal, 878); assert.equal(totals.protein, 31); assert.equal(totals.sodium, 1147);
  assert.equal(totals.matchedItems, 3); assert.equal(totals.status, 'complete');
  assert.deepEqual(calls.sort(), ['3010', '4810']);
  assert.equal(resolved.get('3010').displayName, '雪碧（小杯）');
  assert.equal(resolved.get('3010').supportModify, true);
});

test('portion and piece count stay distinct; punctuation is harmless', async () => {
  const index = n.createIndex(fixture.nutrition);
  assert.equal(index.get(n.normalizedName('雪碧（小杯）')).energyKcal, 76);
  assert.equal(index.get(n.normalizedName('雪碧中杯')).energyKcal, 105);
  assert.equal(index.get(n.normalizedName('麦乐鸡4块')).energyKcal, 170);
  assert.equal(index.get(n.normalizedName('麦乐鸡5块')).energyKcal, 213);
  const unresolved = await resolve([{ code: 'generic', name: '薯条' }], fixture.nutrition, async () => ({ code: 'generic', name: '薯条', rounds: [] }));
  assert.equal(unresolved.get('generic').nutritionEntry.energyKcal, null);
});

test('missing item preserves known single-item values but does not fabricate totals', async () => {
  const items = [menu('1100'), { code: 'seasonal', name: '限定新品' }];
  const resolved = await resolve(items, fixture.nutrition, async code => ({ code, name: '限定新品' }));
  const totals = n.summarizeNutrition(items.map(item => resolved.get(item.code)));
  assert.equal(totals.energyKcal, '暂无'); assert.equal(totals.items[0].energyKcal, 513);
  assert.equal(totals.missingItems[0].name, '限定新品'); assert.equal(totals.matchedItems, 1);
});

test('observed brand and portion ordering aliases preserve sizes, temperatures and counts', async () => {
  assert.equal(n.normalizedName('4块麦乐鸡'), n.normalizedName('麦乐鸡4块'));
  assert.notEqual(n.normalizedName('4块麦乐鸡'), n.normalizedName('麦乐鸡5块'));
  assert.equal(n.normalizedName('麦咖啡™冰奶铁中杯'), n.normalizedName('冰奶铁中杯'));
  assert.notEqual(n.normalizedName('麦咖啡™冰奶铁中杯'), n.normalizedName('热奶铁中杯'));
  assert.equal(n.normalizedName('鲜萃咖啡（大杯）'), n.normalizedName('大杯鲜萃咖啡'));
  assert.equal(n.normalizedName('薯条（中）'), n.normalizedName('中薯条'));
  assert.notEqual(n.normalizedName('小薯条'), n.normalizedName('中薯条'));
  const items = [{ code: '1450', name: '麦香鸡' }, { code: '521143', name: '4块麦乐鸡' }, { code: '507409', name: '麦咖啡™奶铁' }];
  const raw = '[3]{productName,energyKcal,protein,sodium}:\n麦香鸡,369,15,731\n麦乐鸡4块,170,10,337\n冰奶铁中杯,148,8,77';
  const resolved = await resolve(items, raw, async code => ({ code, name: '麦咖啡™冰奶铁中杯' }));
  const sum = n.summarizeNutrition(items.map(item => resolved.get(item.code)));
  assert.equal(sum.energyKcal, 687); assert.equal(sum.protein, 33); assert.equal(sum.sodium, 1145);
});

test('zero is an official value, while null, empty and malformed fields stay unknown', () => {
  const rows = n.createIndex('[2]{productName,energyKcal,protein,sodium}:\n零值,0,0,0\n缺值,null,,unknown');
  assert.equal(rows.get('零值').energyKcal, 0);
  assert.equal(rows.get('缺值').energyKcal, null); assert.equal(rows.get('缺值').protein, null);
  const quoted = n.nutritionRows('[1]{productName,nutritionDescription,energyKcal}:\n餐品,"描述,带逗号",42');
  assert.equal(quoted[0].energyKcal, '42');
});

test('conflicting rows are not arbitrarily chosen', () => {
  const index = n.createIndex([{ productName: '同名', energyKcal: 1 }, { productName: '同名', energyKcal: 2 }]);
  assert.equal(index.get('同名'), null);
});

test('only explicitly default detail choices supply portions', async () => {
  const items = [{ code: 'choice', name: '默认小食' }];
  const detail = { code: 'choice', name: '默认小食', rounds: [{ choices: [
    { name: '小薯条', isDefault: 1, quantity: 1 }, { name: '中薯条', isDefault: 0, quantity: 1 }
  ] }] };
  const resolved = await resolve(items, fixture.nutrition, async () => detail);
  assert.equal(resolved.get('choice').nutritionEntry.energyKcal, 210);
  detail.rounds[0].choices[0].isDefault = 0;
  const unknown = await resolve(items, fixture.nutrition, async () => detail);
  assert.equal(unknown.get('choice').nutritionEntry.energyKcal, null);
});

test('catalog failure and detail failure have distinct explanations', async () => {
  const items = [menu('4810')];
  const failed = await n.resolveNutrition(items, null, () => assert.fail('no detail calls when catalog failed'), true);
  assert.equal(failed.get('4810').nutritionEntry.status, 'unavailable');
  const detailFailed = await resolve(items, fixture.nutrition, async () => { throw Error('test'); });
  assert.equal(detailFailed.get('4810').nutritionEntry.status, 'detail_failed');
});

test('detail lookups are deduplicated across plans and bounded to three concurrent calls', async () => {
  let active = 0, peak = 0, calls = 0;
  const items = Array.from({ length: 9 }, (_, i) => ({ code: String(i), name: `未匹配${i}` }));
  await resolve([...items, ...items], fixture.nutrition, async code => {
    calls++; active++; peak = Math.max(peak, active); await new Promise(done => setTimeout(done, 1)); active--;
    return { code, name: '中薯条' };
  });
  assert.equal(calls, 9); assert.ok(peak <= 3);
});

function cloudHarness() {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/mcd-token/index.js'), 'utf8');
  const ctx = { exports: {}, process: { env: {} }, require(name) {
    if (name === './nutrition') return n;
    if (name === '@cloudbase/node-sdk') return { init() { throw Error('unexpected cloud call'); } };
    if (name.startsWith('./')) return require(path.join(__dirname, '../cloudfunctions/mcd-token', name));
    return require(name);
  } };
  vm.createContext(ctx); vm.runInContext(source, ctx); return ctx;
}

test('cloud Agent refuses to parse or query before a store is provided', async () => {
  const ctx = cloudHarness();
  const result = await vm.runInContext('agent("synthetic-owner", {message:"北京望京预算40元"})', ctx);
  assert.equal(result.mode, 'store_required');
});

test('cloud Agent carries selected store and channel unchanged through model interpretation', async () => {
  const ctx = cloudHarness();
  ctx.syntheticState = require('./helpers/memory-state.cjs').memoryState();
  vm.runInContext(`stateStore = () => syntheticState;
    parseRevisionPatch = async () => ({city:'其他城市', keyword:'其他位置', beType:5});
    liveRecommendation = async (_, event) => { globalThis.captured = event; return {recommendation:{},alternatives:[],toolCalls:['query-meals']}; };
    hy3ExplainPlans = async () => ['测试理由'];`, ctx);
  await vm.runInContext(`agent('synthetic-owner', {message:'选餐',context:{storeCode:'selected',storeName:'选定餐厅',storeAddress:'选定地址',beType:1}})`, ctx);
  assert.equal(ctx.captured.storeCode, 'selected'); assert.equal(ctx.captured.storeAddress, '选定地址'); assert.equal(ctx.captured.beType, 1);
});

test('cloud recommendation uses actual menu/detail/nutrition response shapes with selected store', async () => {
  const ctx = cloudHarness(); const calls = [];
  ctx.fixture = fixture;
  ctx.fakeMcp = async (_, name, args) => {
    calls.push({ name, args });
    if (name === 'query-meals') return { code: 200, data: { meals: Object.fromEntries(fixture.menu.map(item => [item.code, item])) } };
    if (name === 'list-nutrition-foods') return { code: 200, data: fixture.nutrition };
    if (name === 'query-meal-detail') return { code: 200, data: fixture.details[args.code] };
    throw Error(`unexpected tool ${name}`);
  };
  vm.runInContext('selectStoredToken = async () => "synthetic"; mcpTool = fakeMcp;', ctx);
  const result = await vm.runInContext(`liveRecommendation('synthetic-owner', {storeCode:'selected',storeName:'选定餐厅',preferences:{}})`, ctx);
  assert.equal(result.nutritionVersion, 'detail-spec-v2');
  assert.equal(result.recommendation.nutrition.energyKcal, 802);
  assert.ok(result.alternatives.every(plan => plan.nutrition.status === 'complete'));
  assert.ok(calls.filter(call => call.name === 'query-meals' || call.name === 'query-meal-detail').every(call => call.args.storeCode === 'selected'));
  assert.equal(calls.some(call => call.name === 'query-nearby-stores'), false);
  const store = vm.runInContext('normalizeStore({storeCode:"a",latitude:0,longitude:0})', ctx);
  assert.equal(store.latitude, null); assert.equal(store.longitude, null);
});
