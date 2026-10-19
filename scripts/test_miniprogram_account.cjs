// Isolated UI logic regressions. No network, real credentials, or WeChat profile data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/pages/index/index.js'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, '../src/pages/index/index.wxml'), 'utf8');
const custom = { provider: 'openai-compatible', model: 'example-model', baseUrl: 'https://example.test/v1', apiKeyConfigured: true };
const event = (value, dataset = {}) => ({ detail: { value }, currentTarget: { dataset } });
function setup() {
  let page;
  const calls = [];
  const cache = {};
  const wx = {
    cloud: { callFunction: (call) => calls.push(call) },
    login: ({ success }) => success({ code: 'synthetic-code' }),
    getStorageSync: (key) => cache[key],
    setStorageSync: (key, value) => { cache[key] = value; },
    saveFile: ({ success }) => success({ savedFilePath: 'saved://synthetic-avatar' }),
    showToast() {}
  };
  vm.runInNewContext(source, { Page: (definition) => { page = definition; }, wx, getApp: () => ({ globalData: { cloudEnabled: true } }) });
  page.data = structuredClone(page.data);
  page.setData = (patch) => Object.assign(page.data, patch);
  const take = (action) => {
    const index = calls.findIndex((call) => call.data.action === action);
    assert.notEqual(index, -1, `missing ${action}`);
    return calls.splice(index, 1)[0];
  };
  const reply = (action, result) => take(action).success({ result });
  const ready = (provider = { provider: 'hunyuan-v3', model: 'hy3-preview' }) => {
    page.refreshProviderStatus(); reply('provider-status', { ok: true, provider });
  };
  return { page, wx, calls, cache, take, reply, ready };
}

test('background identity lookup never bypasses explicit login or invents profile consent', () => {
  const { page, reply } = setup();
  page.onShow(); reply('status', { ok: true, metadata: null });
  assert.equal(page.data.loggedIn, false);
  assert.equal(page.data.profileComplete, false);
  assert.equal(page.data.cloudIdentityReady, true);
});

test('public order access displays the server cap without an invitation or expiry claim', () => {
  const h = setup(); h.page.loadTestAccount();
  h.reply('order-access', { ok: true, accountFingerprint: 'a'.repeat(64), gate: { enabled: true, mode: 'public', maxTotalCents: 10000, expiresAt: null } });
  assert.match(h.page.data.testAccessText, /已开放下单.*100\.00/);
  assert.doesNotMatch(h.page.data.testAccessText, /测试|邀请|有效至/);
  assert.equal(h.page.data.testAccountBusy, false);
});

test('unbound public account is asked to link its own account and no write is dispatched', () => {
  const h = setup(); h.page.loadTestAccount();
  h.reply('order-access', { ok: true, accountFingerprint: 'b'.repeat(64), gate: { enabled: false, mode: 'disabled', reason: 'account_not_linked' } });
  assert.match(h.page.data.testAccessText, /请先链接本人麦当劳账号/);
  assert.equal(h.calls.length, 0);
});

test('official mini-program button opens the supplied public link without resubmitting or forwarding order secrets', () => {
  const { page, wx, calls } = setup();
  page.data.checkout = { id: 'checkout_example', state: 'created', canPay: false, order: { orderId: 'official-example', status: '1' } };
  page.data.stage = 'order';
  let navigation;
  wx.navigateToMiniProgram = args => { navigation = args; };
  page.openOfficialMiniProgram();
  assert.equal(navigation.shortLink, '#小程序://麦当劳/jbESrg4aBloQz0q'); assert.equal(navigation.envVersion, 'release');
  assert.equal(navigation.extraData, undefined); assert.equal(navigation.path, undefined); assert.equal(navigation.appId, undefined);
  assert.equal(calls.length, 0); assert.equal(page.data.officialJumpBusy, true);
  navigation.success();
  assert.equal(page.data.checkout.order.status, '1'); assert.equal(page.data.officialJumpBusy, false);
  page.onShow();
  assert.equal(calls.filter(call => call.data.action === 'order-refresh').length, 1);
  assert.equal(calls.some(call => /create|cancel/.test(call.data.action)), false);
});

test('failed official navigation offers an explicit copy fallback without automatic retry or copying', () => {
  const { page, wx } = setup(); page.data.checkout = { state: 'unknown' };
  let attempts = 0, clipboard;
  wx.setClipboardData = args => { clipboard = args.data; args.success(); };
  wx.navigateToMiniProgram = args => { attempts++; args.fail({ errMsg: 'navigateToMiniProgram:fail invalid shortLink' }); };
  page.openOfficialMiniProgram();
  assert.equal(attempts, 1); assert.equal(clipboard, undefined); assert.match(page.data.officialJumpFeedback, /复制官方小程序链接/);
  page.copyOfficialMiniProgramLink();
  assert.equal(clipboard, '#小程序://麦当劳/jbESrg4aBloQz0q');
  assert.equal(page.data.checkout.state, 'unknown');
});

test('declined or late official navigation does not alter order status', () => {
  const { page, wx } = setup(); page.data.checkout = { state: 'created', order: { status: '1' } };
  let navigation; wx.navigateToMiniProgram = args => { navigation = args; };
  page.openOfficialMiniProgram(); navigation.fail({ errMsg: 'navigateToMiniProgram:fail cancel' });
  assert.equal(page.data.officialJumpBusy, false); assert.match(page.data.officialJumpFeedback, /已取消跳转/); assert.equal(page.data.checkout.order.status, '1');
  page.openOfficialMiniProgram(); page.onUnload(); const feedback = page.data.officialJumpFeedback;
  navigation.success(); assert.equal(page.data.officialJumpFeedback, feedback); assert.equal(page.data.checkout.order.status, '1');
});

test('both rejected identity and transport failure leave user at login', () => {
  for (const transport of [false, true]) {
    const { page, take } = setup(); page.openProfile(); page.startWechatLogin();
    const call = take('status');
    if (transport) call.fail({}); else call.success({ result: { ok: false } });
    assert.equal(page.data.stage, 'login');
    assert.equal(page.data.loggedIn, false);
    assert.equal(page.data.loginBusy, false);
  }
});

test('successful login requires a visible profile step; onShow does not overwrite it', () => {
  const { page, reply } = setup(); page.openProfile(); page.startWechatLogin();
  reply('status', { ok: true });
  assert.equal(page.data.stage, 'profile-edit');
  assert.equal(page.data.userProfile.nickName, '微信用户');
  const status = page.data.loginStatus;
  reply('status', { ok: true });
  assert.equal(page.data.stage, 'profile-edit');
  assert.equal(page.data.loginStatus, status);
});

test('native nickname autofill uses form submission and saves chosen avatar durably', () => {
  const { page, cache } = setup(); page.data.loggedIn = true; page.editUserProfile();
  page.onChooseAvatar({ detail: { avatarUrl: 'tmp://synthetic-avatar' } });
  page.saveUserProfile({ detail: { value: { nickName: '测试昵称' } } });
  assert.equal(page.data.userProfile.nickName, '测试昵称');
  assert.equal(page.data.userProfile.avatarUrl, 'saved://synthetic-avatar');
  assert.equal(page.data.stage, 'profile');
  assert.equal(cache.maimai_user_profile_v1.nickName, '测试昵称');
});

test('incomplete, rejected, and failed avatar saves do not claim completion', () => {
  const { page, wx } = setup(); page.data.loggedIn = true; page.editUserProfile();
  page.saveUserProfile(event({ nickName: '测试昵称' }));
  assert.equal(page.data.stage, 'profile-edit');
  page.onChooseAvatar({ detail: { avatarUrl: 'tmp://synthetic-avatar' } });
  page.onProfileNickname(event('测试昵称'));
  page.onNicknameReview({ detail: { pass: false } });
  page.onProfileNickname(event('测试昵称')); // A later blur must not clear a rejection.
  page.saveUserProfile(event({ nickName: '测试昵称' }));
  assert.equal(page.data.profileComplete, false);
  page.onProfileNickname(event('修改昵称'));
  wx.saveFile = ({ fail }) => fail({});
  page.saveUserProfile(event({ nickName: '修改昵称' }));
  assert.equal(page.data.profileComplete, false);
  assert.equal(page.data.profileBusy, false);
  assert.equal(page.data.stage, 'profile-edit');
});

test('skip discards draft; existing profile can be edited without losing saved values', () => {
  const { page } = setup(); page.data.loggedIn = true; page.editUserProfile();
  page.onProfileNickname(event('未保存昵称')); page.skipUserProfile();
  assert.equal(page.data.profileComplete, false);
  assert.notEqual(page.data.userProfile.nickName, '未保存昵称');
  page.data.profileComplete = true; page.data.userProfile = { avatarUrl: 'saved://avatar', nickName: '已有昵称' };
  page.editUserProfile(); page.onProfileNickname(event('未保存修改')); page.skipUserProfile();
  assert.equal(page.data.userProfile.nickName, '已有昵称');
});

test('provider opens from home, changes draft only, and preserves edits across refresh', () => {
  const { page, ready, reply } = setup(); ready(); page.openProviderSettings();
  assert.equal(page.data.stage, 'provider');
  page.selectProvider(event('', { provider: 'openai-compatible' }));
  page.onProviderSettingInput(event('draft-model', { key: 'model' }));
  reply('provider-status', { ok: true, provider: { provider: 'hunyuan-v3', model: 'hy3-preview' } });
  assert.equal(page.data.providerSettings.model, 'draft-model');
  assert.equal(page.data.activeProvider.provider, 'hunyuan-v3');
  page.closeProviderSettings(); assert.equal(page.data.stage, 'home');
});

test('switch commits only server-acknowledged state; stale reads cannot undo the save', () => {
  const { page, ready, take } = setup(); ready(); page.openProviderSettings();
  const stale = take('provider-status');
  page.selectProvider(event('', { provider: 'openai-compatible' }));
  page.onProviderSettingInput(event(custom.model, { key: 'model' }));
  page.onProviderSettingInput(event(custom.baseUrl, { key: 'baseUrl' }));
  page.onProviderApiKeyInput(event('synthetic-secret'));
  assert.equal(JSON.stringify(page.data).includes('synthetic-secret'), false);
  page.saveProviderSettings();
  assert.equal(page._providerApiKey, '');
  assert.equal(page.data.activeProvider.provider, 'hunyuan-v3');
  take('provider-save').success({ result: { ok: true, provider: custom } });
  stale.success({ result: { ok: true, provider: { provider: 'hunyuan-v3' } } });
  assert.equal(page.data.activeProvider.model, custom.model);
  assert.equal(page.data.providerDirty, false);
});

test('save failure preserves active config and clears key; transport uncertainty re-reads', () => {
  const { page, ready, take, reply } = setup(); ready(custom); page.openProviderSettings();
  page.onProviderSettingInput(event('changed-model', { key: 'model' }));
  page.onProviderApiKeyInput(event('synthetic-secret')); page.saveProviderSettings();
  take('provider-save').success({ result: { ok: false } });
  assert.equal(page.data.activeProvider.model, custom.model);
  assert.equal(page._providerApiKey, '');
  take('provider-status'); // Drop the stale read started on opening.
  page.saveProviderSettings(); take('provider-save').fail({});
  assert.equal(page.data.providerReady, false);
  reply('provider-status', { ok: true, provider: { ...custom, model: 'changed-model' } });
  assert.equal(page.data.activeProvider.model, 'changed-model');
});

test('changing API host requires a new key; hide and close erase credential input', () => {
  const { page, ready, calls } = setup(); ready(custom); page.openProviderSettings();
  page.onProviderSettingInput(event('https://different.test/v1', { key: 'baseUrl' }));
  page.saveProviderSettings(); assert.equal(calls.some(c => c.data.action === 'provider-save'), false);
  page.onProviderApiKeyInput(event('synthetic-secret')); const version = page.data.providerKeyVersion;
  page.onHide(); assert.equal(page._providerApiKey, ''); assert.ok(page.data.providerKeyVersion > version);
  page.onProviderApiKeyInput(event('synthetic-secret')); page.closeProviderSettings(); assert.equal(page._providerApiKey, '');
});

function providerServerHarness() {
  const writes = [];
  const existing = { provider: 'openai-compatible', model: 'old-model', baseUrl: 'https://example.test/v1', encryptedApiKey: 'synthetic-old-ciphertext' };
  const ctx = { exports: {}, URL, Buffer,
    process: { env: { MCD_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') } },
    fetch() { assert.fail('provider validation must not use the network'); },
    require(name) {
      if (name === '@cloudbase/node-sdk') return { init() { assert.fail('provider validation must not call CloudBase'); } };
      if (name.startsWith('./')) return require(path.join(__dirname, '../cloudfunctions/mcd-token', name));
      return require(name);
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/mcd-token/index.js'), 'utf8'), ctx);
  ctx.selectProviderConfig = async () => existing;
  ctx.selectMetadata = async () => ({ status: 'active' });
  ctx.dbModels = () => ({ $runSQL: async (sql, params) => { writes.push({ sql, params }); } });
  return { ctx, writes, existing };
}

test('server rejects local hosts, IP literals and embedded credentials before storing a provider URL', () => {
  const { ctx } = providerServerHarness();
  for (const host of ['localhost', 'localhost.', 'api.localhost', '127.0.0.2', '127.1', '2130706433', '0x7f000001',
    '10.0.0.1', '192.168.0.1', '169.254.169.254', '[::]', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]',
    '[fc00::1]', '[fe80::1]', '1.1.1.1', '[2001:4860:4860::8888]']) {
    assert.throws(() => ctx.safeProviderUrl(`https://${host}/v1`), /HTTPS hostname/);
  }
  assert.throws(() => ctx.safeProviderUrl('https://user:synthetic@example.test/v1'), /HTTPS hostname/);
  assert.throws(() => ctx.safeProviderUrl('http://example.test/v1'), /HTTPS hostname/);
  assert.equal(ctx.safeProviderUrl(' https://example.test/v1/ '), 'https://example.test/v1');
});

test('server refuses to reuse a stored key at a changed provider URL even if the client bypasses UI validation', async () => {
  const { ctx, writes, existing } = providerServerHarness();
  for (const baseUrl of ['https://different.test/v1', 'https://example.test:8443/v1', 'https://example.test/other']) {
    await assert.rejects(ctx.saveProviderConfig('synthetic-owner', { provider: 'openai-compatible', model: 'new-model', baseUrl }), /new provider API key/);
  }
  assert.equal(writes.length, 0);
  const result = await ctx.saveProviderConfig('synthetic-owner', { provider: 'openai-compatible', model: 'new-model', baseUrl: existing.baseUrl });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].params.encryptedApiKey, existing.encryptedApiKey);
  assert.equal(result.provider.apiKeyConfigured, true);
  assert.equal(JSON.stringify(result).includes(existing.encryptedApiKey), false);
});

test('server encrypts a newly supplied key for a changed endpoint and never returns the key', async () => {
  const { ctx, writes } = providerServerHarness();
  const syntheticKey = 'synthetic-provider-key';
  const result = await ctx.saveProviderConfig('synthetic-owner', {
    provider: 'openai-compatible', model: 'new-model', baseUrl: 'https://different.test/v1', apiKey: syntheticKey
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].params.baseUrl, 'https://different.test/v1');
  assert.notEqual(writes[0].params.encryptedApiKey, syntheticKey);
  assert.equal(ctx.decryptToken(writes[0].params.encryptedApiKey), syntheticKey);
  assert.equal(JSON.stringify(result).includes(syntheticKey), false);
});

test('Agent waits for known saved provider; request does not send UI draft or API key', () => {
  const { page, ready, calls, reply, take } = setup(); page.data.tokenLinked = true; page.data.agentMessage = '选餐';
  page.data.selectedStore = { storeCode: 'store-a', storeName: '测试餐厅', address: '测试地址', businessStatus: true };
  page.data.storeConfirmed = true;
  page.runAgentMessage(); assert.equal(calls.some(c => c.data.action === 'agent'), false);
  reply('provider-status', { ok: true, provider: custom });
  page.runAgentMessage(); const request = take('agent').data;
  assert.equal(request.provider, undefined); assert.equal(request.apiKey, undefined);
  assert.equal(request.message, '选餐');
  assert.equal(request.context.storeCode, 'store-a');
  assert.equal(request.context.storeAddress, '测试地址');
  assert.equal(JSON.stringify(request).includes('latitude'), false);
});

test('both home entry and direct Agent action require a confirmed open store', () => {
  const { page, calls } = setup();
  page.openAgentComposer(); assert.equal(page.data.stage, 'location');
  page.data.agentMessage = '预算40元'; page.data.providerReady = true; page.data.tokenLinked = true;
  page.data.selectedStore = { storeCode: 'a', businessStatus: true };
  page.runAgentMessage(); assert.equal(page.data.stage, 'location');
  assert.equal(calls.some(call => call.data.action === 'agent'), false);
  page.confirmStore(); assert.equal(page.data.stage, 'agent'); assert.equal(page.data.storeConfirmed, true);
  page.data.selectedStore.businessStatus = false;
  page.runAgentMessage(); assert.equal(calls.some(call => call.data.action === 'agent'), false);
});

test('new location search clears confirmation and stale responses cannot replace chosen stores', () => {
  const { page, take } = setup(); page.data.tokenLinked = true;
  page.data.storeConfirmed = true; page.loadLiveStores('北京', '位置A');
  const old = take('stores'); assert.equal(page.data.storeConfirmed, false);
  page.loadLiveStores('上海', '位置B'); const latest = take('stores');
  latest.success({ result: { ok: true, mode: 'live_mcp', stores: [{ storeCode: 'b', storeName: 'B', businessStatus: true, latitude: 0, longitude: 0 }] } });
  page.confirmStore();
  old.success({ result: { ok: true, mode: 'live_mcp', stores: [{ storeCode: 'a', businessStatus: true }] } });
  assert.equal(page.data.selectedStore.storeCode, 'b');
  assert.equal(page.data.mapMarkers.length, 0); assert.equal(page.data.selectedStorePoint, null);
  page.selectCity(event('', { city: '深圳' }));
  assert.equal(page.data.storeConfirmed, false); assert.equal(page.data.selectedStore, null);
});

test('no open stores cannot be confirmed and errors remain on location step', () => {
  const { page, reply } = setup(); page.data.tokenLinked = true; page.startFlow(); page.loadLiveStores('北京', '望京');
  reply('stores', { ok: true, mode: 'live_mcp', stores: [{ storeCode: 'closed', businessStatus: false }] });
  assert.equal(page.data.selectedStore, null); page.confirmStore(); assert.equal(page.data.stage, 'location');
  assert.match(page.data.storesError, /暂无正在营业/);
});

test('explicit general snapshot never silently selects a real fallback store', () => {
  const { page, calls } = setup(); page.data.tokenLinked = true; page.useGeneralSnapshot(); page.buildRecommendation();
  assert.equal(calls.some(call => call.data.action === 'recommend'), false);
  assert.equal(page.data.storeConfirmed, false);
});

test('Agent page preserves map navigation for the confirmed restaurant', () => {
  const { page, wx } = setup(); let route;
  wx.openLocation = (args) => { route = args; };
  page.data.selectedStore = { storeCode: 'a', storeName: '测试餐厅', address: '测试地址', businessStatus: true };
  page.data.selectedStorePoint = { latitude: 39.9, longitude: 116.4 };
  page.confirmStore(); page.openRouteToStore();
  assert.equal(page.data.stage, 'agent'); assert.equal(route.name, '测试餐厅');
  assert.equal(route.latitude, 39.9);
  const home = template.slice(0, template.indexOf('麦麦管家登录'));
  assert.doesNotMatch(home, /bindtap="runAgentMessage"/);
  const composer = template.slice(template.indexOf("stage === 'agent'"), template.indexOf('<!-- ============ 提问'));
  assert.match(composer, /bindtap="openRouteToStore"/);
  assert.match(composer, /bindtap="runAgentMessage"/);
});

test('rendered controls use supported native capabilities and expose home switching', () => {
  assert.match(template, /open-type="chooseAvatar"/);
  assert.match(template, /name="nickName" type="nickname"/);
  assert.match(template, /form bindsubmit="saveUserProfile"/);
  const home = template.slice(0, template.indexOf('麦麦管家登录'));
  assert.match(home, /bindtap="openProviderSettings"/);
  assert.match(home, /activeProvider\.model/);
  assert.doesNotMatch(source, /getUserProfile|profileAuthorized|providerApiKeyDraft/);
});

function startAgent(harness) {
  harness.page.setData({ stage: 'agent', tokenLinked: true, providerReady: true, storeConfirmed: true,
    selectedStore: { storeCode: 'selected', storeName: '测试餐厅', businessStatus: true }, agentMessage: '预算40元' });
  harness.page.runAgentMessage();
  return harness.take('agent');
}

function liveReply(name = '真实推荐') {
  return { result: { ok: true, mode: 'live_mcp', recommendation: { name, items: [
    { name: '主食', type: '主食' }, { name: '配餐', type: '配餐' }, { name: '饮料', type: '饮料' }
  ], total: '38.90', dataStatus: '实时 MCP' }, alternatives: [] } };
}

test('Agent shows an independent waiting screen and atomically opens only the new result', () => {
  const h = setup(); const updates = [];
  const setData = h.page.setData;
  h.page.setData = patch => { updates.push(patch); setData(patch); };
  const call = startAgent(h);
  assert.equal(h.page.data.stage, 'agent-waiting'); assert.equal(h.page.data.agentBusy, true);
  assert.equal(updates.some(patch => patch.stage === 'result'), false);
  h.page.runAgentMessage(); assert.equal(h.calls.filter(call => call.data.action === 'agent').length, 0);
  call.success(liveReply());
  assert.equal(h.page.data.stage, 'result'); assert.equal(h.page.data.recommendation.name, '真实推荐');
  const shown = updates.filter(patch => patch.stage === 'result');
  assert.equal(shown.length, 1); assert.equal(shown[0].recommendation.name, '真实推荐');
  assert.equal(shown[0].agentBusy, false);
  const waiting = template.slice(template.indexOf("stage === 'agent-waiting'"), template.indexOf('<!-- ============ 提问'));
  assert.doesNotMatch(waiting, /recommendation\.|alternatives|orderDraft/);
});

test('Agent failures and malformed or fixture responses never reveal the previous meal and can retry', () => {
  for (const kind of ['transport', 'application', 'malformed', 'fixture']) {
    const h = setup(); const call = startAgent(h);
    if (kind === 'transport') call.fail({});
    else if (kind === 'application') call.success({ result: { ok: false, error: 'test' } });
    else if (kind === 'malformed') call.success({ result: { ok: true, mode: 'live_mcp', recommendation: {} } });
    else call.success({ result: { ok: true, mode: 'fixture', recommendation: h.page.data.recommendation } });
    assert.equal(h.page.data.stage, 'agent-waiting'); assert.equal(h.page.data.agentBusy, false);
    assert.ok(h.page.data.agentError); assert.equal(h.page.data.agentMessage, '预算40元');
    h.page.runAgentMessage(); assert.equal(h.page.data.agentBusy, true); assert.equal(h.page.data.agentError, '');
    h.take('agent').success(liveReply('重试成功'));
    assert.equal(h.page.data.stage, 'result'); assert.equal(h.page.data.recommendation.name, '重试成功');
  }
});

test('leaving the waiting screen keeps the prompt and ignores late callbacks including after a retry', () => {
  const h = setup(); const old = startAgent(h);
  h.page.leaveAgentWaiting(); assert.equal(h.page.data.stage, 'agent'); assert.equal(h.page.data.agentBusy, false);
  assert.equal(h.page.data.agentMessage, '预算40元');
  h.page.runAgentMessage(); const current = h.take('agent');
  old.success(liveReply('过期结果')); old.fail({});
  assert.equal(h.page.data.stage, 'agent-waiting'); assert.equal(h.page.data.agentBusy, true);
  assert.equal(h.page.data.agentError, '');
  current.success(liveReply('当前结果'));
  assert.equal(h.page.data.recommendation.name, '当前结果');
});

test('conflicts and clarification exit waiting into the appropriate state without old order cards', () => {
  for (const mode of ['constraint_conflict', 'clarifying', 'store_required']) {
    const h = setup(); const call = startAgent(h);
    call.success({ result: { ok: true, mode, reason: '没有符合条件的组合', question: '请调整条件' } });
    assert.equal(h.page.data.agentBusy, false);
    if (mode === 'constraint_conflict') {
      assert.equal(h.page.data.stage, 'result'); assert.ok(h.page.data.recommendationConflict);
      assert.equal(h.page.data.orderDraft, null);
    } else assert.equal(h.page.data.stage, mode === 'clarifying' ? 'agent' : 'location');
  }
});

test('unloading the page prevents a pending Agent response from changing page state', () => {
  const h = setup(); const call = startAgent(h); h.page.onUnload();
  call.success(liveReply('过期结果'));
  assert.notEqual(h.page.data.stage, 'result');
});

function quoteView(overrides = {}) {
  return { id: 'checkout_test', revision: 1, state: 'quoted', gate: { enabled: true }, store: { storeName: '测试餐厅' },
    quote: { total: '25.00', takeWays: [{ code: 'take', title: '自取' }], items: [] }, ...overrides };
}
test('checkout needs a server conversation and quotes only selected items, quantities and tableware', () => {
  const h = setup(); h.page.openCheckout(); assert.equal(h.calls.length, 0);
  h.page.data.tokenLinked = true; h.page.data.conversation = { id: 'conversation_test', revision: 2 };
  h.page.data.recommendation = { id: 'meal', items: [{ code: 'burger', name: '汉堡' }] };
  h.page.openCheckout(); const call = h.take('checkout-quote');
  assert.equal(h.page.data.stage, 'checkout'); assert.equal(h.page.data.checkoutBusy, true);
  assert.equal(call.data.conversationId, 'conversation_test'); assert.equal(call.data.quantities.burger, 1);
  assert.equal('total' in call.data, false);
  call.success({ result: { ok: true, checkout: quoteView() } });
  h.page.changeQuoteQuantity(event('', { code: 'burger', delta: 1 }));
  assert.equal(h.page.data.checkout, null); assert.equal(h.take('checkout-quote').data.quantities.burger, 2);
});
test('create only follows the explicit modal approval and uses the server confirmation nonce', () => {
  const h = setup(); let modal; h.wx.showModal = options => modal = options;
  h.page.data.checkout = quoteView(); h.page.data.takeWayCode = 'take';
  h.page.confirmCheckout(); h.reply('checkout-prepare', { ok: true, checkout: quoteView({ revision: 2 }), confirmation: { nonce: 'server-nonce', total: '25.00', takeWay: '自取' } });
  assert.equal(h.calls.some(c => c.data.action === 'checkout-create'), false);
  modal.success({ confirm: false }); assert.equal(h.page.data.checkoutBusy, false);
  h.page.confirmCheckout(); h.reply('checkout-prepare', { ok: true, checkout: quoteView({ revision: 3 }), confirmation: { nonce: 'fresh-nonce', total: '25.00', takeWay: '自取' } });
  modal.success({ confirm: true }); const create = h.take('checkout-create');
  assert.equal(create.data.nonce, 'fresh-nonce'); assert.equal(create.data.revision, 3); assert.equal(create.data.confirmed, true);
  h.page.confirmCheckout(); assert.equal(h.calls.length, 0);
  create.fail({}); assert.equal(h.page.data.stage, 'order'); assert.match(h.page.data.checkoutError, /不会自动重发/);
});
test('a changed official quote remains on the confirmation screen for review', () => {
  const h = setup(); h.wx.showModal = modal => modal.success({ confirm: true });
  h.page.data.checkout = quoteView(); h.page.data.takeWayCode = 'take'; h.page.confirmCheckout();
  h.reply('checkout-prepare', { ok: true, checkout: quoteView({ revision: 2 }), confirmation: { nonce: 'n', total: '25.00' } });
  h.reply('checkout-create', { ok: true, priceChanged: true, checkout: quoteView({ revision: 3 }) });
  assert.equal(h.page.data.stage, 'checkout'); assert.match(h.page.data.checkoutError, /报价发生变化/);
});
test('payment navigation carries only the internal checkout ID and return triggers a status read', () => {
  const h = setup(); let url; h.wx.navigateTo = options => url = options.url;
  h.page.data.checkout = quoteView({ canPay: true }); h.page.openPayment();
  assert.equal(url, '/pages/payment/index?id=checkout_test'); assert.doesNotMatch(url, /https|payId/);
  h.page.data.stage = 'order'; h.page.onShow(); assert.equal(h.take('order-refresh').data.checkoutId, 'checkout_test');
});
test('cancel has a reason picker and a separate confirmation; declining does not write', () => {
  const h = setup(); let modal; h.wx.showActionSheet = options => options.success({ tapIndex: 2 }); h.wx.showModal = options => modal = options;
  h.page.data.checkout = quoteView({ canCancel: true, order: { orderId: 'synthetic-order' } }); h.page.cancelOrder();
  const prepare = h.take('order-cancel-prepare'); assert.equal(prepare.data.reasonCode, '3');
  prepare.success({ result: { ok: true, checkout: h.page.data.checkout, confirmation: { nonce: 'n' } } });
  modal.success({ confirm: false }); assert.equal(h.calls.length, 0); assert.equal(h.page.data.checkoutBusy, false);
});
test('saving preferences requires consent and a stale background read cannot undo saved state', () => {
  const h = setup(); h.page.data.preferencesReady = true; h.page.savePreferences(); assert.equal(h.calls.length, 0);
  h.page.refreshPreferences(); const stale = h.take('preferences-get');
  h.page.toggleMemory(event(true)); h.page.savePreferences(); const save = h.take('preferences-save');
  assert.equal(save.data.consent, true);
  const preferences = { saved: true, enabled: true, revision: 1, settings: { budgetMax: 35, mood: 'balanced', dietary: [], exclusions: [] } };
  save.success({ result: { ok: true, preferences } });
  stale.success({ result: { ok: true, preferences: { saved: false, enabled: false, revision: 0 } } });
  assert.equal(h.page.data.preferences.revision, 1); assert.equal(h.page.data.agentSettings.budgetMax, 35);
});
