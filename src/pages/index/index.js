const CITIES = [
  { name: '北京', keyword: '望京', store: '北京望京街店' },
  { name: '上海', keyword: '五角场', store: '上海五角场店' },
  { name: '深圳', keyword: '科技园', store: '深圳科技园店' },
  { name: '广州', keyword: '天河城', store: '广州天河城店' }
];

const MCD_MCP_LOGIN_URL = 'https://open.mcd.cn/mcp/login';
// Official mini-program share link supplied by the project owner; never append order credentials.
const MCD_OFFICIAL_MINIPROGRAM_LINK = '#小程序://麦当劳/jbESrg4aBloQz0q';
const MAP_MARKER_ICON = '/assets/map-marker.png';
const PROFILE_STORAGE_KEY = 'maimai_user_profile_v1';

function providerView(config) {
  const custom = config && config.provider === 'openai-compatible';
  return {
    provider: custom ? 'openai-compatible' : 'hunyuan-v3',
    label: custom ? '自定义接口' : '腾讯混元 HY3',
    model: config && config.model || (custom ? '' : 'hy3-preview'),
    baseUrl: custom && config.baseUrl || '',
    apiKeyConfigured: Boolean(custom && config.apiKeyConfigured)
  };
}

const QUESTIONS = [
  {
    key: 'budget',
    title: '这顿大概想花多少？',
    copy: '预算只用于排序，不会限制你查看其他方案。',
    options: [
      { value: 'light', label: '¥25 以内' },
      { value: 'standard', label: '¥25–40' },
      { value: 'free', label: '预算随意' }
    ]
  },
  {
    key: 'mood',
    title: '今天想吃哪种感觉？',
    copy: '告诉我一个大方向，具体搭配交给我。',
    options: [
      { value: 'satisfying', label: '满足一点，想吃得过瘾' },
      { value: 'light', label: '清爽一点，别太有负担' },
      { value: 'balanced', label: '均衡就好' }
    ]
  },
  {
    key: 'mode',
    title: '准备怎么吃？',
    copy: '没有偏好也没关系，可以直接跳过。',
    options: [
      { value: 'dine-in', label: '到店堂食' },
      { value: 'pickup', label: '到店取餐' },
      { value: 'delivery', label: '外送到家' }
    ]
  }
];

const FIXTURE_RECOMMENDATIONS = {
  default: {
    name: '经典满足一人餐',
    subtitle: '巨无霸 · 薯条 · 无糖可乐',
    items: [
      { type: '主食', name: '巨无霸', price: '¥25.00' },
      { type: '配餐', name: '中薯条', price: '¥11.00' },
      { type: '饮料', name: '无糖可乐（中）', price: '¥8.00' }
    ],
    nutrition: { energyKcal: 845, protein: 31, sodium: 1020, source: 'demo fixture（待 MCP 验证）' },
    total: '44.00',
    summary: '均衡满足 · ¥44.00',
    priceSource: 'demo fixture（待 MCP 验证）',
    updatedAt: '2026-10-11 14:00',
    dataStatus: '非实时',
    reason: '按“均衡预算 + 想吃得满足”的默认规则组合；饮料选择无糖款，保留口感同时减少额外糖分。'
  },
  light: {
    name: '清爽轻盈一人餐',
    subtitle: '板烧鸡腿堡 · 玉米杯 · 纯牛奶',
    items: [
      { type: '主食', name: '板烧鸡腿堡', price: '¥22.00' },
      { type: '配餐', name: '玉米杯', price: '¥9.00' },
      { type: '饮料', name: '纯牛奶', price: '¥8.00' }
    ],
    nutrition: { energyKcal: 610, protein: 29, sodium: 780, source: 'demo fixture（待 MCP 验证）' },
    total: '39.00',
    summary: '清爽 · ¥39.00',
    priceSource: 'demo fixture（待 MCP 验证）',
    updatedAt: '2026-10-11 14:00',
    dataStatus: '非实时',
    reason: '优先选择蔬菜配餐和相对清爽的主食，适合今天想吃轻一点的你。'
  },
  value: {
    name: '刚刚好一人餐',
    subtitle: '麦香鸡 · 小薯条 · 柠檬红茶',
    items: [
      { type: '主食', name: '麦香鸡', price: '¥15.00' },
      { type: '配餐', name: '小薯条', price: '¥6.00' },
      { type: '饮料', name: '柠檬红茶（中）', price: '¥4.00' }
    ],
    nutrition: { energyKcal: 620, protein: 20, sodium: 890, source: 'demo fixture（待 MCP 验证）' },
    total: '25.00',
    summary: '预算友好 · ¥25.00',
    priceSource: 'demo fixture（待 MCP 验证）',
    updatedAt: '2026-10-11 14:00',
    dataStatus: '非实时',
    reason: '把预算控制在 ¥25 左右，保留主食、配餐和饮料的完整结构；适合作为默认起点。'
  }
};

function makeOrderDraft(recommendation, locationLabel, store) {
  const items = Array.isArray(recommendation && recommendation.items) ? recommendation.items : [];
  return {
    state: 'confirmation_required',
    source: 'recommendation',
    id: recommendation && recommendation.id ? recommendation.id : items.map((item) => item.name).join('|'),
    location: store && store.storeName ? store.storeName : (locationLabel || '当前推荐门店'),
    storeCode: store && store.storeCode ? store.storeCode : '',
    store: { storeCode: store && store.storeCode ? store.storeCode : '', storeName: store && store.storeName ? store.storeName : (locationLabel || '当前推荐门店'), address: store && store.address ? store.address : '' },
    items: items.map((item) => ({ code: item.code || '', name: item.name, type: item.type, price: item.price, quantity: 1 })),
    total: recommendation && recommendation.total,
    nutrition: recommendation && recommendation.nutrition,
    priceSource: recommendation && recommendation.priceSource,
    payment: { state: 'not_started', merchant: '麦当劳官方', message: '当前为菜单估价，下一步核对官方应付金额；尚未创建订单。' },
    writeToolsEnabled: false,
    confirmationRequired: true,
  };
}

function coordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildMapMarkers(stores, storePoints) {
  return (Array.isArray(stores) ? stores : []).map((store, index) => {
    const point = storePoints && storePoints[store.storeCode];
    const latitude = coordinate(store.latitude) ?? coordinate(point && point.latitude);
    const longitude = coordinate(store.longitude) ?? coordinate(point && point.longitude);
    if (latitude === null || longitude === null || (latitude === 0 && longitude === 0)) return null;
    return {
      id: index + 1,
      latitude,
      longitude,
      iconPath: MAP_MARKER_ICON,
      width: 30,
      height: 30,
      callout: { content: store.storeName || '推荐门店', display: 'ALWAYS', padding: 6, borderRadius: 4, bgColor: '#ffffff', color: '#171717', fontSize: 12 }
    };
  }).filter(Boolean);
}

function planKey(plan) {
  return plan && plan.id
    ? String(plan.id)
    : (plan && Array.isArray(plan.items) ? plan.items.map((item) => `${item.type || ''}:${item.code || item.name || ''}`).join('|') : String(plan && plan.name || ''));
}

function uniquePlans(plans) {
  const seen = {};
  return (Array.isArray(plans) ? plans : []).filter((plan) => {
    const key = planKey(plan);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

Page({
  data: {
    stage: 'home',
    checkout: null,
    checkoutBusy: false,
    checkoutError: '',
    officialJumpBusy: false,
    officialJumpFeedback: '',
    checkoutQuantities: {},
    needTableware: false,
    takeWayCode: '',
    acceptOverBudget: false,
    orders: [],
    ordersBusy: false,
    ordersError: '',
    ordersReturnStage: 'profile',
    loggedIn: false,
    loginStatus: '未登录 · 点击微信登录',
    userProfile: { avatarUrl: '', nickName: '游客' },
    profileComplete: false,
    profileDraft: { avatarUrl: '', nickName: '' },
    profileBusy: false,
    profileFeedback: '',
    loginBusy: false,
    cloudIdentityReady: false,
    accountReturnStage: 'home',
    connectReturnStage: 'home',
    tokenInputVersion: 0,
    tokenInputEmpty: true,
    tokenBusy: false,
    tokenFeedback: '',
    cities: CITIES,
    showCityPicker: false,
    selectedCity: '',
    locationInfo: null,
    hasLocation: false,
    locationKeyword: '',
    locationStatus: '',
    stores: [],
    storePoints: {},
    selectedStorePoint: null,
    mapCenter: null,
    mapMarkers: [],
    mapScale: 15,
    mapHint: '',
    mapPickingStore: false,
    storesLoading: false,
    storesError: '',
    selectedStore: null,
    storeConfirmed: false,
    selectedBeType: 1,
    locationLabel: '通用菜单',
    questionIndex: 0,
    progress: 33,
    currentQuestion: QUESTIONS[0],
    answers: {},
    recommendation: FIXTURE_RECOMMENDATIONS.default,
    alternatives: [FIXTURE_RECOMMENDATIONS.light, FIXTURE_RECOMMENDATIONS.value],
    alternativePool: [FIXTURE_RECOMMENDATIONS.light, FIXTURE_RECOMMENDATIONS.value],
    orderDraft: makeOrderDraft(FIXTURE_RECOMMENDATIONS.default, '通用菜单', null),
    recommendationLoading: false,
    recommendationError: '',
    recommendationConflict: null,
    agentMessage: '',
    agentBusy: false,
    agentError: '',
    agentErrorCode: '',
    conversation: null,
    agentChanges: [],
    alternativeBusy: false,
    agentFeedback: '',
    agentExplanation: '',
    memoryAgreed: false,
    memoryStatus: '未保存本次偏好',
    preferences: { saved: false, enabled: false, revision: 0, settings: null },
    preferencesReady: false,
    preferencesBusy: false,
    preferencesDirty: false,
    preferencesFeedback: '',
    preferenceBudgetInput: '40',
    preferenceBudgetValid: true,
    agentSettings: {
      budget: 'standard',
      budgetMax: 40,
      mood: 'balanced',
      dietary: '未设置',
      exclusions: '未设置',
      detailedReason: true
    },
    activeProvider: providerView(null),
    providerSettings: providerView(null),
    providerReady: false,
    providerDirty: false,
    providerReturnStage: 'home',
    providerKeyVersion: 0,
    providerKeyEmpty: true,
    providerBusy: false,
    providerFeedback: '',
    testAccountBusy: false,
    testAccountId: '',
    testAccountLabel: '',
    testAccessText: '刷新可查看本账号的下单权限和单笔额度。',
    testAccountFeedback: '',
    tokenLinked: false,
    tokenStatus: '未链接 · 本人 MCP 账号'
  },

  onShow() {
    this.setData({ officialJumpBusy: false });
    this.refreshTokenStatus();
    if (this.data.stage === 'order' && this.data.checkout) this.refreshOrder();
  },

  checkoutCall(action, data, success, failure) {
    wx.cloud.callFunction({ name: 'mcd-token', data: { action, ...data },
      success: response => {
        const result = response && response.result;
        if (result && result.ok) success(result);
        else failure(result && result.error || '暂时无法完成，请稍后重试', result && result.code || 'operation_failed');
      }, fail: () => failure('网络暂不可用，请刷新查询。已确认提交的订单不会自动重发。', 'transport_unknown') });
  },
  openCheckout() {
    if (this.data.agentBusy || this.data.recommendationLoading || this.data.recommendationConflict || !this.data.conversation || !this.data.tokenLinked) return;
    const quantities = {};
    (this.data.recommendation.items || []).forEach(item => { quantities[item.code] = 1; });
    this.setData({ stage: 'checkout', checkout: null, checkoutQuantities: quantities, needTableware: false, takeWayCode: '', acceptOverBudget: false, checkoutError: '', officialJumpFeedback: '' });
    this.requestQuote();
  },
  requestQuote() {
    if (this.data.checkoutBusy || !this.data.conversation) return;
    this.setData({ checkoutBusy: true, checkoutError: '', checkout: null, takeWayCode: '', acceptOverBudget: false });
    this.checkoutCall('checkout-quote', { conversationId: this.data.conversation.id, revision: this.data.conversation.revision,
      planId: this.data.recommendation.id, quantities: this.data.checkoutQuantities, needTableware: this.data.needTableware },
    result => this.setData({ checkout: result.checkout, checkoutBusy: false, takeWayCode: result.checkout.quote.takeWays.length === 1 ? result.checkout.quote.takeWays[0].code : '' }),
    error => this.setData({ checkoutBusy: false, checkoutError: error }));
  },
  changeQuoteQuantity(event) {
    if (this.data.checkoutBusy) return;
    const { code, delta } = event.currentTarget.dataset;
    if (!Object.prototype.hasOwnProperty.call(this.data.checkoutQuantities, code)) return;
    const quantity = this.data.checkoutQuantities[code] + Number(delta);
    if (quantity < 1 || quantity > 10) return;
    this.setData({ checkoutQuantities: { ...this.data.checkoutQuantities, [code]: quantity } });
    this.requestQuote();
  },
  changeTableware(event) {
    if (this.data.checkoutBusy) return;
    this.setData({ needTableware: event.detail.value === true }); this.requestQuote();
  },
  selectTakeWay(event) { if (!this.data.checkoutBusy) this.setData({ takeWayCode: event.currentTarget.dataset.code }); },
  acceptQuoteBudget(event) { this.setData({ acceptOverBudget: event.detail.value === true }); },
  closeCheckout() { if (!this.data.checkoutBusy) this.setData({ stage: 'result', checkoutError: '' }); },
  confirmCheckout() {
    const checkout = this.data.checkout;
    if (this.data.checkoutBusy || !checkout || !checkout.gate.enabled || !this.data.takeWayCode) return;
    this.setData({ checkoutBusy: true, checkoutError: '' });
    const fail = error => this.setData({ checkoutBusy: false, checkoutError: error });
    this.checkoutCall('checkout-prepare', { checkoutId: checkout.id, revision: checkout.revision, takeWayCode: this.data.takeWayCode, acceptOverBudget: this.data.acceptOverBudget }, result => {
      this.setData({ checkout: result.checkout });
      const items = (result.checkout.quote.items || []).map(item => `${item.officialName || item.name} × ${item.quantity}`).join('\n');
      wx.showModal({ title: '确认创建这笔订单', content: `${result.checkout.store.storeName || this.data.locationLabel}\n${items}\n${result.confirmation.takeWay}\n合计 ¥${result.confirmation.total}\n确认后将创建麦当劳订单，随后前往官方付款。`, confirmText: '确认下单',
        success: answer => {
          if (!answer.confirm) { this.setData({ checkoutBusy: false }); return; }
          this.checkoutCall('checkout-create', { checkoutId: result.checkout.id, revision: result.checkout.revision, nonce: result.confirmation.nonce, confirmed: true }, created => {
            this.setData({ checkoutBusy: false, checkout: created.checkout, stage: created.checkout.state === 'quoted' ? 'checkout' : 'order',
              checkoutError: created.priceChanged ? '官方报价发生变化，请重新核对金额并确认。' : '' });
            if (created.checkout.state === 'created') this.refreshOrder();
          }, (error, code) => {
            const beforeWrite = ['confirmation_expired', 'quote_expired', 'version_conflict', 'plan_changed', 'write_disabled', 'test_amount_limit', 'order_check_unavailable'].includes(code);
            this.setData({ stage: beforeWrite ? 'checkout' : 'order' }); fail(error);
          });
        }, fail: () => fail('未完成确认，请重试') });
    }, fail);
  },
  openOrders() {
    this.setData({ ordersReturnStage: this.data.stage, stage: 'orders' }); this.loadOrders();
  },
  closeOrders() { this.setData({ stage: this.data.ordersReturnStage || 'profile' }); },
  loadOrders() {
    if (this.data.ordersBusy) return;
    this.setData({ ordersBusy: true, ordersError: '' });
    this.checkoutCall('orders-list', {}, result => this.setData({ orders: result.orders, ordersBusy: false }), error => this.setData({ ordersError: error, ordersBusy: false }));
  },
  openOrder(event) {
    const checkout = this.data.orders.find(item => item.id === event.currentTarget.dataset.id);
    if (!checkout) return;
    this.setData({ checkout, stage: 'order', checkoutError: '', officialJumpFeedback: '' }); this.refreshOrder();
  },
  backToOrders() { if (!this.data.checkoutBusy) { this.setData({ stage: 'orders' }); this.loadOrders(); } },
  refreshOrder() {
    if (this.data.checkoutBusy || !this.data.checkout) return;
    this.setData({ checkoutBusy: true, checkoutError: '' });
    this.checkoutCall('order-refresh', { checkoutId: this.data.checkout.id }, result => this.setData({ checkout: result.checkout, checkoutBusy: false }),
      error => this.setData({ checkoutError: error, checkoutBusy: false }));
  },
  resumeCheckout() {
    if (!this.data.checkoutBusy && this.data.checkout && this.data.checkout.state === 'quoted') this.setData({ stage: 'checkout', checkoutError: '' });
  },
  openPayment() {
    if (this.data.checkoutBusy || !this.data.checkout || !this.data.checkout.canPay) return;
    wx.navigateTo({ url: '/pages/payment/index?id=' + encodeURIComponent(this.data.checkout.id) });
  },
  openOfficialMiniProgram() {
    if (this.data.checkoutBusy || this.data.officialJumpBusy || !this.data.checkout || this.data.checkout.state === 'quoted') return;
    const requestId = this._officialNavigationId = (this._officialNavigationId || 0) + 1;
    const fail = error => {
      if (requestId !== this._officialNavigationId) return;
      this.setData({ officialJumpBusy: false, officialJumpFeedback: /cancel/i.test(String(error && error.errMsg || ''))
        ? '已取消跳转，订单未改变。'
        : '暂时无法跳转。可复制官方小程序链接在微信中打开，或打开麦当劳官方 App 查看这笔已有订单。' });
    };
    this.setData({ officialJumpBusy: true, officialJumpFeedback: '' });
    if (typeof wx.navigateToMiniProgram !== 'function') { fail(); return; }
    // Keep navigation in the user's tap handler; do not put an async API call before it.
    try {
      wx.navigateToMiniProgram({ shortLink: MCD_OFFICIAL_MINIPROGRAM_LINK, envVersion: 'release',
        success: () => { if (requestId === this._officialNavigationId) this.setData({ officialJumpBusy: false, officialJumpFeedback: '请在官方“我的订单”找到已有订单；返回后会自动查询最新状态。' }); }, fail });
    } catch (_) { fail(); }
  },
  copyOfficialMiniProgramLink() {
    wx.setClipboardData({ data: MCD_OFFICIAL_MINIPROGRAM_LINK,
      success: () => this.setData({ officialJumpFeedback: '已复制官方小程序链接，可粘贴到微信聊天中打开。进入后在“我的订单”查找已有订单。' }),
      fail: () => this.setData({ officialJumpFeedback: '复制失败，请在微信搜索“麦当劳”，或打开官方 App 查看已有订单。' }) });
  },
  copyOfficialOrderId() {
    const id = this.data.checkout && this.data.checkout.order && this.data.checkout.order.orderId;
    if (!id) return;
    wx.setClipboardData({ data: String(id),
      success: () => this.setData({ officialJumpFeedback: '订单号已复制，可用于在官方订单列表核对这笔订单。' }),
      fail: () => this.setData({ officialJumpFeedback: '未能复制订单号，请重试。' }) });
  },
  confirmRecoveredOrder() {
    const checkout = this.data.checkout;
    if (this.data.checkoutBusy || !checkout || !checkout.recoveryCandidate) return;
    const candidate = checkout.recoveryCandidate;
    wx.showModal({ title: '核对并关联这笔订单', content: `${candidate.storeName}\n订单 ${candidate.orderId}\n${candidate.statusText} · ¥${candidate.total}\n请确认这是你本次提交的订单；关联不会再次下单。`, confirmText: '确认关联', success: answer => {
      if (!answer.confirm || this.data.checkoutBusy) return;
      this.setData({ checkoutBusy: true, checkoutError: '' });
      this.checkoutCall('order-reconcile', { checkoutId: checkout.id, revision: checkout.revision, confirmed: true },
        result => this.setData({ checkout: result.checkout, checkoutBusy: false }), error => this.setData({ checkoutError: error, checkoutBusy: false }));
    } });
  },
  cancelOrder() {
    const checkout = this.data.checkout;
    if (this.data.checkoutBusy || !checkout || !checkout.canCancel) return;
    const reasons = ['改主意了', '重复下单', '点错了 / 点多了 / 点少了', '地址 / 电话填错了', '送达时间选错了', '其他原因'];
    this.setData({ checkoutBusy: true, checkoutError: '' });
    const fail = error => this.setData({ checkoutBusy: false, checkoutError: error });
    wx.showActionSheet({ itemList: reasons, success: choice => {
      const reasonCode = ['1', '2', '3', '4', '5', '-1'][choice.tapIndex];
      if (!reasonCode) { this.setData({ checkoutBusy: false }); return; }
      this.checkoutCall('order-cancel-prepare', { checkoutId: checkout.id, reasonCode }, result => {
        this.setData({ checkout: result.checkout });
        wx.showModal({ title: '确认取消这笔订单', content: `${result.checkout.order.storeName || result.checkout.store.storeName || ''}\n订单 ${result.checkout.order.orderId}\n金额 ¥${result.checkout.order.total}\n${reasons[choice.tapIndex]}\n取消结果以麦当劳官方查询为准。`, confirmText: '确认取消',
          success: answer => {
            if (!answer.confirm) { this.setData({ checkoutBusy: false }); return; }
            this.checkoutCall('order-cancel', { checkoutId: checkout.id, revision: result.checkout.revision, nonce: result.confirmation.nonce, confirmed: true },
              cancelled => { this.setData({ checkout: cancelled.checkout, checkoutBusy: false }); if (cancelled.checkout.cancelState === 'accepted') this.refreshOrder(); }, fail);
          }, fail: () => fail('未完成取消确认') });
      }, fail);
    }, fail: () => this.setData({ checkoutBusy: false }) });
  },

  refreshTokenStatus() {
    const app = typeof getApp === 'function' ? getApp() : null;
    if (!app || !app.globalData || !app.globalData.cloudEnabled || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return;
    wx.cloud.callFunction({
      name: 'mcd-token',
      data: { action: 'status' },
      success: (response) => {
        const result = response && response.result;
        if (!result || !result.ok) {
          this.setData({ cloudIdentityReady: false });
          return;
        }
        const metadata = result.metadata;
        const linked = Boolean(metadata && metadata.status === 'active');
        const statusText = metadata && metadata.status === 'disconnected'
          ? '已断开 · Token 未被读取'
          : metadata && metadata.status === 'invalid'
            ? '已失效 · 需要重新链接'
            : linked
              ? '已链接 · 本人 MCP 账号'
              : '未链接 · 本人 MCP 账号';
        this.setData({
          cloudIdentityReady: true,
          tokenLinked: linked,
          tokenStatus: statusText
        });
        this.refreshProviderStatus();
        this.refreshPreferences();
      },
      fail: () => this.setData({ cloudIdentityReady: false })
    });
  },

  startFlow() {
    this.setData({ stage: 'location', showCityPicker: false });
  },

  openAbout() {
    wx.navigateTo({
      url: '/pages/about/index',
      fail: () => wx.showToast({ title: '说明暂时无法打开，请重试', icon: 'none' })
    });
  },

  openAgentComposer() {
    if (!this.data.storeConfirmed || !this.data.selectedStore || !this.data.selectedStore.storeCode) {
      this.setData({ stage: 'location', agentFeedback: '先选好餐厅，Agent 会按这家门店的菜单选餐。' });
      return;
    }
    this.setData({ stage: 'agent', agentFeedback: '' });
  },

  startQuestionnaire() {
    this.setData({ stage: 'question', questionIndex: 0, currentQuestion: QUESTIONS[0], progress: 33 });
  },

  openProfile() {
    this.setData({ accountReturnStage: this.data.stage, stage: this.data.loggedIn ? 'profile' : 'login' });
  },

  loadTestAccount() {
    if (this.data.testAccountBusy) return;
    const requestId = this._testAccountRequestId = (this._testAccountRequestId || 0) + 1;
    const failed = () => {
      if (requestId !== this._testAccountRequestId) return;
      this.setData({ testAccountBusy: false, testAccountId: '', testAccountLabel: '', testAccessText: '暂时无法读取下单权限，请重试。' });
    };
    this.setData({ testAccountBusy: true, testAccountId: '', testAccountLabel: '', testAccountFeedback: '', testAccessText: '正在读取下单权限…' });
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) { failed(); return; }
    wx.cloud.callFunction({ name: 'mcd-token', data: { action: 'order-access' },
      success: response => {
        if (requestId !== this._testAccountRequestId) return;
        const result = response && response.result;
        const id = result && result.accountFingerprint;
        if (!result || !result.ok || typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) { failed(); return; }
        const gate = result.gate || {};
        let status = '尚未开通下单测试，请把测试账号标识发给邀请人。';
        if (gate.enabled === true && Number.isSafeInteger(gate.maxTotalCents) && gate.maxTotalCents > 0) {
          status = (gate.mode === 'public' ? '已开放下单 · 单笔上限 ¥' : '已开通受邀测试 · 单笔上限 ¥') + (gate.maxTotalCents / 100).toFixed(2);
          if (Number.isFinite(gate.expiresAt)) {
            if (gate.expiresAt <= Date.now()) status = '下单测试资格已到期，请联系邀请人。';
            else status += ' · 有效至 ' + new Date(gate.expiresAt + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）';
          }
        } else if (gate.reason === 'closed') status = '下单已暂停，可继续体验选餐与报价。';
        else if (gate.reason === 'expired') status = '下单测试资格已到期，请联系邀请人。';
        else if (gate.reason === 'account_not_linked') status = '请先链接本人麦当劳账号，再刷新下单权限。';
        else if (gate.reason === 'unavailable') status = '暂时无法读取下单权限，请稍后刷新。';
        this.setData({ testAccountBusy: false, testAccountId: id, testAccountLabel: id.slice(0, 8) + '…' + id.slice(-8), testAccessText: status });
      }, fail: failed });
  },

  copyTestAccount() {
    const id = this.data.testAccountId;
    if (this.data.testAccountBusy || !/^[a-f0-9]{64}$/.test(id)) return;
    wx.setClipboardData({ data: id,
      success: () => this.setData({ testAccountFeedback: '已复制账号标识，可提供给运营者排查权限问题。' }),
      fail: () => this.setData({ testAccountFeedback: '未能复制，请重试。' }) });
  },

  startWechatLogin() {
    if (this.data.loginBusy) return;
    const app = typeof getApp === 'function' ? getApp() : null;
    if (!app || !app.globalData || !app.globalData.cloudEnabled || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      this.setData({ loggedIn: false, loginStatus: 'CloudBase 身份服务暂不可用，可先以游客体验' });
      return;
    }
    this.setData({ loginBusy: true, loginStatus: '正在确认微信身份…' });
    const failLogin = () => this.setData({ loginBusy: false, loggedIn: false, loginStatus: '未能确认微信身份，请重试' });
    const confirmIdentity = () => wx.cloud.callFunction({
      name: 'mcd-token',
      data: { action: 'status' },
      success: (response) => {
        const result = response && response.result;
        if (result && result.ok) {
          let saved = null;
          try { saved = wx.getStorageSync(PROFILE_STORAGE_KEY); } catch (_) { /* Cache is optional. */ }
          const complete = Boolean(saved && saved.avatarUrl && saved.nickName);
          this.setData({
            loggedIn: true, cloudIdentityReady: true, loginBusy: false,
            userProfile: complete ? { avatarUrl: saved.avatarUrl, nickName: saved.nickName } : { avatarUrl: '', nickName: '微信用户' },
            profileComplete: complete,
            loginStatus: complete ? '已登录 · 使用已保存的头像昵称' : '已登录 · 待完善头像昵称'
          });
          this.editUserProfile();
          this.refreshTokenStatus();
        } else {
          failLogin();
        }
      },
      fail: failLogin
    });
    // Identity and user-chosen profile details are separate WeChat capabilities.
    if (typeof wx.login === 'function') wx.login({ success: confirmIdentity, fail: failLogin });
    else confirmIdentity();
  },

  editUserProfile() {
    if (!this.data.loggedIn) return;
    this._nicknameRejected = false;
    this.setData({ stage: 'profile-edit', profileFeedback: '', profileDraft: {
      avatarUrl: this.data.userProfile.avatarUrl || '',
      nickName: this.data.profileComplete ? this.data.userProfile.nickName : ''
    } });
  },

  onChooseAvatar(event) {
    const avatarUrl = event.detail && event.detail.avatarUrl;
    if (!avatarUrl || this.data.profileBusy) return;
    this.setData({ profileDraft: Object.assign({}, this.data.profileDraft, { avatarUrl }), profileFeedback: '' });
  },

  onAvatarError() {
    this.setData({ profileFeedback: '头像未能选取，请重新点击选择。' });
  },

  onProfileNickname(event) {
    const nickName = String(event.detail.value || '');
    if (nickName !== this.data.profileDraft.nickName) this._nicknameRejected = false;
    this.setData({ profileDraft: Object.assign({}, this.data.profileDraft, { nickName }),
      profileFeedback: this._nicknameRejected ? '昵称未通过微信检查，请修改后再保存。' : '' });
  },

  onSavedAvatarError() {
    if (!this.data.loggedIn) return;
    this.setData({ userProfile: { avatarUrl: '', nickName: this.data.userProfile.nickName }, profileComplete: false,
      loginStatus: '已登录 · 头像已失效，请重新选择' });
  },

  onNicknameReview(event) {
    this._nicknameRejected = event.detail.pass === false;
    if (this._nicknameRejected) this.setData({ profileFeedback: '昵称未通过微信检查，请修改后再保存。' });
  },

  saveUserProfile(event) {
    if (!this.data.loggedIn || this.data.profileBusy) return;
    // Form values include native nickname autofill even when bindinput was not fired.
    const values = event && event.detail && event.detail.value;
    const nickName = String(values && typeof values.nickName === 'string' ? values.nickName : this.data.profileDraft.nickName).trim();
    const avatarUrl = this.data.profileDraft.avatarUrl;
    if (!avatarUrl || !nickName || this._nicknameRejected) {
      this.setData({ profileFeedback: this._nicknameRejected ? '请修改昵称后再保存。' : '请选择头像并填写昵称；也可以点“暂不填写”。' });
      return;
    }
    this.setData({ profileBusy: true, profileFeedback: '' });
    const save = (savedAvatar) => {
      const profile = { avatarUrl: savedAvatar, nickName };
      try { wx.setStorageSync(PROFILE_STORAGE_KEY, profile); }
      catch (_) {
        this.setData({ profileBusy: false, profileFeedback: '本机保存失败，请重试。' });
        return;
      }
      this.setData({ userProfile: profile, profileComplete: true, profileBusy: false, loginStatus: '已登录 · 头像昵称已保存', stage: 'profile' });
    };
    if (avatarUrl === this.data.userProfile.avatarUrl) save(avatarUrl);
    else wx.saveFile({
      tempFilePath: avatarUrl,
      success: (response) => save(response.savedFilePath),
      fail: () => this.setData({ profileBusy: false, profileFeedback: '头像保存失败，请重新选择头像。' })
    });
  },

  skipUserProfile() {
    if (this.data.profileBusy) return;
    this.setData({ stage: 'profile', profileDraft: { avatarUrl: '', nickName: '' }, profileFeedback: '',
      loginStatus: this.data.profileComplete ? '已登录 · 使用已保存的头像昵称' : '已登录 · 暂未填写头像昵称' });
  },

  viewGuestProfile() {
    this.setData({ stage: 'profile' });
  },

  backFromAccount() {
    if (this.data.loginBusy) return;
    this.setData({ stage: this.data.accountReturnStage || 'home' });
  },

  openConnection() {
    this.clearTokenInput();
    this.refreshTokenStatus();
    this.setData({ connectReturnStage: this.data.stage, stage: 'connect' });
  },

  backFromConnection() {
    this.clearTokenInput();
    this.setData({ stage: this.data.connectReturnStage || 'home' });
  },

  backToHome() {
    this.setData({ stage: 'home' });
  },

  openMcpPortal() {
    this.clearTokenInput();
    // web-view occupies a whole page; native navigation provides the back control.
    wx.navigateTo({
      url: '/pages/mcp-portal/index',
      fail: () => wx.showToast({ title: '页面未打开，请重试或复制链接', icon: 'none' })
    });
  },

  copyMcpAddress() {
    wx.setClipboardData({
      data: MCD_MCP_LOGIN_URL,
      success: () => wx.showToast({ title: '链接已复制，请在浏览器打开', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' })
    });
  },

  backHome() { this.setData({ stage: 'home' }); },

  onAgentInput(event) {
    this.setData({ agentMessage: String(event.detail.value || ''), agentFeedback: '' });
  },

  runAgentMessage() {
    const message = String(this.data.agentMessage || '').trim();
    if (!message || this.data.agentBusy) return;
    const selected = this.data.selectedStore;
    if (!this.data.storeConfirmed || !selected || !selected.storeCode || selected.businessStatus === false) {
      this.setData({ stage: 'location', agentFeedback: '请先确认一家营业门店，再让 Agent 选餐。' });
      return;
    }
    if (this.data.providerBusy || !this.data.providerReady) {
      this.setData({ agentFeedback: '正在确认当前供应商，请稍后重试。' });
      this.refreshProviderStatus();
      return;
    }
    if (!this.data.tokenLinked) {
      this.setData({ agentFeedback: '先链接你的麦当劳 MCP Token，Agent 才能读取实时菜单。' });
      return;
    }
    const requestId = this._agentRequestId = (this._agentRequestId || 0) + 1;
    this.setData({ stage: 'agent-waiting', agentBusy: true, agentError: '', agentErrorCode: '', recommendationLoading: true, recommendationError: '', agentFeedback: '', agentExplanation: '' });
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    const showError = (result) => {
      if (requestId !== this._agentRequestId) return;
      this.setData({ stage: 'agent-waiting', recommendationLoading: false, agentBusy: false,
        agentErrorCode: result && result.code || '',
        agentError: result && result.error || '暂时没有拿到推荐，请重试或返回修改要求。' });
    };
    wx.cloud.callFunction({
      name: 'mcd-token',
      data: {
        action: 'agent',
        message,
        conversationId: this.data.conversation && this.data.conversation.id,
        revision: this.data.conversation && this.data.conversation.revision,
        context: {
          city: this.data.selectedCity,
          keyword: this.data.locationKeyword,
          storeCode: selected && selected.storeCode,
          storeName: selected && selected.storeName,
          storeAddress: selected && selected.address,
          beCode: selected && selected.beCode,
          beType: this.data.selectedBeType,
          settingsOverride: this.data.preferencesDirty,
          settings: {
            budgetMax: this.data.agentSettings.budgetMax,
            mood: this.data.agentSettings.mood,
            dietary: this.data.agentSettings.dietary === '未设置' ? [] : [this.data.agentSettings.dietary],
            exclusions: this.data.agentSettings.exclusions === '未设置' ? [] : this.data.agentSettings.exclusions.split(/[、,，]/).map((item) => item.trim()).filter(Boolean)
          }
        }
      },
      success: (response) => {
        if (requestId !== this._agentRequestId) return;
        const result = response && response.result;
        if (result && result.ok && ['live_mcp', 'order_draft'].includes(result.mode) && result.recommendation
          && Array.isArray(result.recommendation.items) && result.recommendation.items.length >= 1 && result.recommendation.items.length <= 3) {
          this.applyMealResult(result);
          if (result.mode === 'order_draft' && typeof this.openCheckout === 'function') this.openCheckout();
        } else if (result && result.mode === 'constraint_conflict') {
          this.setData({ stage: 'result', conversation: result.conversation || this.data.conversation, recommendationLoading: false, agentBusy: false, recommendationConflict: { reason: result.reason || '当前条件没有可用组合。', question: result.question || '要放宽哪一项？' }, recommendationError: '', orderDraft: null });
        } else if (result && result.mode === 'store_required') {
          this.setData({ stage: 'location', storeConfirmed: false, recommendationLoading: false, agentBusy: false, agentFeedback: result.question });
        } else if (result && result.mode === 'clarifying') {
          this.setData({ stage: 'agent', recommendationLoading: false, agentBusy: false, agentFeedback: result.question || '请补充选餐要求。' });
        } else {
          showError(result);
        }
      },
      fail: () => showError()
    });
  },

  leaveAgentWaiting() {
    // A late response must not reopen results after the user returns to edit.
    this._agentRequestId = (this._agentRequestId || 0) + 1;
    this.setData({ stage: 'agent', agentBusy: false, agentError: '', recommendationLoading: false, agentFeedback: '' });
  },

  applyMealResult(result) {
    const recommendation = Object.assign({}, result.recommendation, { reason: result.recommendation.agentReason || (result.agent && result.agent.explanation) || result.recommendation.reason });
    this.setData({ stage: 'result', recommendation,
      conversation: result.conversation || null, agentChanges: result.conversation && result.conversation.changes || [],
      alternatives: uniquePlans(result.alternatives || []).slice(0, 2), alternativePool: uniquePlans(result.alternatives || []),
      locationLabel: result.location || this.data.locationLabel, recommendationLoading: false, agentBusy: false,
      agentMessage: '', agentError: '', agentErrorCode: '', agentExplanation: '', recommendationConflict: null,
      orderDraft: result.orderDraft || makeOrderDraft(recommendation, result.location || this.data.locationLabel, result.store || this.data.selectedStore) });
  },

  refreshConversation() {
    if (!this.data.conversation || this.data.agentBusy) return;
    this.setData({ agentBusy: true });
    wx.cloud.callFunction({ name: 'mcd-token', data: { action: 'conversation-get', conversationId: this.data.conversation.id },
      success: response => {
        const result = response && response.result;
        if (result && result.ok && result.mode === 'live_mcp' && result.recommendation) this.applyMealResult(result);
        else this.setData({ agentBusy: false, conversation: null, agentError: '本轮方案已过期，请返回重新填写选餐要求。', agentErrorCode: 'session_expired' });
      }, fail: () => this.setData({ agentBusy: false, agentError: '读取方案失败，请稍后重试。' }) });
  },

  newConversation() {
    const previous = this.data.conversation;
    this._agentRequestId = (this._agentRequestId || 0) + 1;
    this.setData({ conversation: null, agentChanges: [], agentMessage: '', agentBusy: false, recommendationLoading: false });
    if (previous && wx.cloud && wx.cloud.callFunction) wx.cloud.callFunction({ name: 'mcd-token', data: { action: 'conversation-clear', conversationId: previous.id } });
  },

  backToLocation() { this.setData({ stage: this.data.storeConfirmed ? 'agent' : 'location', showCityPicker: false }); },

  loadLiveStores(city, keyword) {
    if (!this.data.tokenLinked || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      return false;
    }
    this.newConversation();
    const requestId = this._storeQueryId = (this._storeQueryId || 0) + 1;
    this.setData({ storesLoading: true, storesError: '', stores: [], selectedStore: null, storeConfirmed: false, selectedStorePoint: null, mapMarkers: [] });
    wx.cloud.callFunction({
      name: 'mcd-token',
      data: { action: 'stores', city, keyword, beType: 1 },
      success: (response) => {
        if (requestId !== this._storeQueryId) return;
        const result = response && response.result;
        if (result && result.ok && result.mode === 'live_mcp' && Array.isArray(result.stores)) {
          const stores = result.stores;
          const nearest = stores.find((store) => store.businessStatus !== false) || null;
          const storePoints = Object.assign({}, this.data.storePoints);
          stores.forEach((store) => {
            if (coordinate(store.latitude) !== null && coordinate(store.longitude) !== null && !(Number(store.latitude) === 0 && Number(store.longitude) === 0)) {
              storePoints[store.storeCode] = { latitude: coordinate(store.latitude), longitude: coordinate(store.longitude) };
            }
          });
          const nearestPoint = nearest && storePoints[nearest.storeCode] ? storePoints[nearest.storeCode] : null;
          this.setData({ stores, selectedStore: nearest, selectedStorePoint: nearestPoint, storePoints, mapCenter: this.data.mapCenter || nearestPoint, mapMarkers: buildMapMarkers(stores, storePoints), storesLoading: false, storesError: nearest ? '' : '附近暂无正在营业的门店，请更换搜索位置。' });
        } else {
          const outsideChina = !/[\u4e00-\u9fa5]/.test(String(city || ''));
          this.setData({ storesLoading: false, storesError: outsideChina ? '当前定位不在麦当劳中国 MCP 的门店服务范围内，请在中国大陆位置测试；也可以手动选择中国城市。' : ((result && result.error) || '实时门店查询失败，请改用通用菜单快照。') });
        }
      },
      fail: () => {
        if (requestId === this._storeQueryId) this.setData({ storesLoading: false, storesError: '实时门店查询失败，请更换位置或稍后重试。' });
      }
    });
    return true;
  },

  selectStore(event) {
    const code = String(event.currentTarget.dataset.code || '');
    const selected = this.data.stores.find((store) => String(store.storeCode) === code);
    if (!selected || selected.businessStatus === false) return;
    if (this.data.selectedStore && this.data.selectedStore.storeCode !== selected.storeCode) this.newConversation();
    const selectedStorePoint = this.data.storePoints && this.data.storePoints[code] ? this.data.storePoints[code] : null;
    this.setData({ selectedStore: selected, storeConfirmed: false, selectedStorePoint, mapCenter: this.data.mapCenter || selectedStorePoint, mapMarkers: buildMapMarkers(this.data.stores, this.data.storePoints) });
  },

  chooseSelectedStoreLocation() {
    const store = this.data.selectedStore;
    if (!store || typeof wx === 'undefined' || typeof wx.chooseLocation !== 'function') {
      if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: '暂时无法打开地图选点', icon: 'none' });
      return;
    }
    this.setData({ mapPickingStore: true, mapHint: `请在微信地图中点选 ${store.storeName} 的实际位置，然后点击右上角完成。` });
    wx.chooseLocation({
      success: (point) => {
        const latitude = coordinate(point.latitude);
        const longitude = coordinate(point.longitude);
        if (latitude === null || longitude === null) {
          wx.showToast({ title: '门店位置无效，请重新选择', icon: 'none' });
          return;
        }
        const storePoints = Object.assign({}, this.data.storePoints, { [store.storeCode]: { latitude, longitude } });
        this.setData({ mapPickingStore: false, selectedStorePoint: { latitude, longitude }, storePoints, mapCenter: { latitude, longitude }, mapMarkers: buildMapMarkers(this.data.stores, storePoints), mapHint: `已在地图上标记 ${store.storeName}；位置仅保存在本次页面。` });
      },
      fail: () => this.setData({ mapPickingStore: false, mapHint: '这次没有完成地图选点；请再次点击“在地图上标记这家门店”，在地图中点选后点击完成。' })
    });
  },

  openRouteToStore() {
    const store = this.data.selectedStore;
    const point = store && this.data.selectedStorePoint;
    const latitude = coordinate(point && point.latitude);
    const longitude = coordinate(point && point.longitude);
    if (!store || latitude === null || longitude === null) {
      this.chooseSelectedStoreLocation();
      return;
    }
    wx.openLocation({ latitude, longitude, name: store.storeName || '麦当劳推荐门店', address: store.address || '', scale: 16 });
  },

  confirmStore() {
    const store = this.data.selectedStore;
    if (!store || !store.storeCode || store.businessStatus === false || this.data.storesLoading) return;
    this.setData({
      locationLabel: `${this.data.selectedCity || '附近'} · ${store.storeName}`,
      stage: 'agent',
      storeConfirmed: true,
      agentFeedback: '',
      showCityPicker: false,
      storesError: ''
    });
  },

  locationQueryFromPoint(point) {
    const address = String(point && point.address || '').trim();
    const name = String(point && point.name || '').trim();
    const matched = CITIES.find((item) => address.includes(item.name) || name.includes(item.name));
    const cityMatch = address.match(/([^省市区县]+)市/);
    const foreignCity = address.split(/[,，]/).map((part) => part.trim()).find((part) => /[A-Za-z]/.test(part));
    const city = matched ? matched.name : (cityMatch ? cityMatch[1] : (foreignCity || this.data.selectedCity));
    const keyword = name || address.replace(/^[^省市]+省?[^市]+市?/, '').trim() || address;
    return { city, keyword };
  },

  continueFromLocatedPoint(point, fallbackLocation) {
    const query = this.locationQueryFromPoint(point);
    if (!query.city || !query.keyword) {
      this.setData({ showCityPicker: false, locationStatus: '已获取当前位置，但地图没有返回可查询的商圈名称；可用“手动选择城市”继续。', storesError: '' });
      return;
    }
    this.setData({
      selectedCity: query.city,
      locationKeyword: query.keyword,
      showCityPicker: false,
      storesError: '',
      locationStatus: `已定位到 ${query.city} · ${query.keyword}，正在查询附近门店…`,
      mapCenter: fallbackLocation ? { latitude: fallbackLocation.latitude, longitude: fallbackLocation.longitude } : this.data.mapCenter
    });
    if (this.loadLiveStores(query.city, query.keyword)) return;
    this.setData({ stores: [], selectedStore: null, storeConfirmed: false, selectedStorePoint: null,
      locationStatus: '已选择位置，请先链接麦当劳 MCP，再查询附近门店。' });
  },

  allowLocation() {
    const self = this;
    if (typeof wx === 'undefined' || !wx.getLocation) {
      self.setData({ showCityPicker: true, locationStatus: '当前环境无法定位，请手动选择城市和商圈。' });
      return;
    }
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: true,
      success(location) {
        self.setData({
          locationInfo: { latitude: location.latitude, longitude: location.longitude },
          hasLocation: true,
          mapCenter: { latitude: location.latitude, longitude: location.longitude },
          mapMarkers: buildMapMarkers(self.data.stores, self.data.storePoints),
          locationStatus: '已获取当前位置；定位只保存在本次页面，不会写入账户。'
        });
        if (typeof wx.chooseLocation !== 'function') {
          self.setData({ showCityPicker: false, storesError: '已获取位置，但当前运行环境没有地图反向地址能力；可用“手动选择城市”继续。' });
          return;
        }
        wx.chooseLocation({
          latitude: location.latitude,
          longitude: location.longitude,
          success(point) { self.continueFromLocatedPoint(point, location); },
          fail() { self.setData({ showCityPicker: false, storesError: '已获取当前位置；请用“手动选择城市”或再次打开地图选择附近位置。' }); }
        });
      },
      fail() {
        wx.showToast({ title: '未获取位置，可手动选择', icon: 'none' });
        self.setData({ showCityPicker: true, locationStatus: '未获取当前位置，可手动选择城市。' });
      }
    });
  },

  openManualCity() { this.setData({ showCityPicker: true }); },

  selectCity(event) {
    this._storeQueryId = (this._storeQueryId || 0) + 1;
    this.setData({ selectedCity: event.currentTarget.dataset.city, locationKeyword: '', stores: [], selectedStore: null,
      storeConfirmed: false, selectedStorePoint: null, mapMarkers: [], storesLoading: false, storesError: '' });
  },

  onLocationKeywordInput(event) {
    this._storeQueryId = (this._storeQueryId || 0) + 1;
    this.setData({ locationKeyword: String(event.detail.value || ''), stores: [], selectedStore: null, storeConfirmed: false,
      selectedStorePoint: null, mapMarkers: [], storesLoading: false, storesError: '' });
  },

  confirmCity() {
    const city = CITIES.find((item) => item.name === this.data.selectedCity);
    if (!city) return;
    if (this.loadLiveStores(city.name, this.data.locationKeyword || city.keyword)) return;
    this.setData({ storesError: '请先链接麦当劳 MCP，再查询真实门店；也可以单独体验通用菜单快照。' });
  },

  useGeneralSnapshot() {
    this.newConversation();
    this._storeQueryId = (this._storeQueryId || 0) + 1;
    this.setData({ locationLabel: '通用菜单快照', stage: 'question', questionIndex: 0, currentQuestion: QUESTIONS[0], progress: 33, showCityPicker: false, stores: [], storesLoading: false, selectedStore: null, storeConfirmed: false, selectedStorePoint: null, storesError: '', locationInfo: null, hasLocation: false, locationKeyword: '', locationStatus: '', storePoints: {}, mapCenter: null, mapMarkers: [], mapHint: '' });
  },

  selectAnswer(event) {
    const key = event.currentTarget.dataset.key;
    const value = event.currentTarget.dataset.value;
    const answers = Object.assign({}, this.data.answers, { [key]: value });
    this.setData({ answers });
  },

  skipQuestion() { this.advanceQuestion(); },

  nextQuestion() { this.advanceQuestion(); },

  advanceQuestion() {
    if (this.data.questionIndex >= QUESTIONS.length - 1) {
      this.buildRecommendation();
      return;
    }
    const nextIndex = this.data.questionIndex + 1;
    this.setData({ questionIndex: nextIndex, currentQuestion: QUESTIONS[nextIndex], progress: Math.round(((nextIndex + 1) / QUESTIONS.length) * 100) });
  },

  buildRecommendation() {
    const answers = Object.assign({}, this.data.agentSettings, this.data.answers);
    let recommendation = FIXTURE_RECOMMENDATIONS.default;
    if (answers.mood === 'light') recommendation = FIXTURE_RECOMMENDATIONS.light;
    if (answers.budget === 'light') recommendation = FIXTURE_RECOMMENDATIONS.value;
    this.setData({ stage: 'result', recommendation, alternatives: this.data.alternatives, alternativePool: uniquePlans(this.data.alternatives), recommendationConflict: null, orderDraft: makeOrderDraft(recommendation, this.data.locationLabel, this.data.selectedStore) });

    if (this.data.tokenLinked && this.data.storeConfirmed && this.data.selectedStore && typeof wx !== 'undefined' && wx.cloud && wx.cloud.callFunction) {
      this.setData({ recommendationLoading: true, recommendationError: '' });
      wx.cloud.callFunction({
        name: 'mcd-token',
        data: {
          action: 'recommend',
          preferences: answers,
          locationLabel: this.data.locationLabel,
          storeCode: this.data.selectedStore && this.data.selectedStore.storeCode,
          storeName: this.data.selectedStore && this.data.selectedStore.storeName,
          storeAddress: this.data.selectedStore && this.data.selectedStore.address,
          beCode: this.data.selectedStore && this.data.selectedStore.beCode,
          beType: this.data.selectedBeType
        },
        success: (response) => {
          const result = response && response.result;
          if (result && result.ok && result.mode === 'live_mcp' && result.recommendation) {
            this.setData({ recommendation: result.recommendation, alternatives: uniquePlans(result.alternatives || []).slice(0, 2), alternativePool: uniquePlans(result.alternatives || []), recommendationLoading: false, recommendationConflict: null, orderDraft: result.orderDraft || makeOrderDraft(result.recommendation, this.data.locationLabel, this.data.selectedStore) });
          } else if (result && result.mode === 'constraint_conflict') {
            this.setData({ recommendationLoading: false, recommendationConflict: { reason: result.reason || '当前条件没有可用组合。', question: result.question || '要放宽哪一项？' }, recommendationError: '', orderDraft: null });
          } else {
            this.setData({ recommendationLoading: false, recommendationError: (result && result.error) || '实时 MCP 查询失败，已保留演示数据。' });
          }
        },
        fail: () => this.setData({ recommendationLoading: false, recommendationError: '实时 MCP 查询失败，已保留演示数据。' })
      });
    }

    // The local fixture is the safe default. A controlled build can point to
    // the read-only recommendation backend after HTTPS/domain validation.
    const app = typeof getApp === 'function' ? getApp() : null;
    const backendURL = app && app.globalData ? app.globalData.backendURL : '';
    if (!backendURL || (app && app.globalData && app.globalData.fixtureMode) || typeof wx === 'undefined' || !wx.request) return;
    wx.request({
      url: `${backendURL}/api/recommend`,
      method: 'POST',
      data: { preferences: answers, locationLabel: this.data.locationLabel },
      success: (response) => {
        const body = response && response.data;
        if (!body || body.mode !== 'fixture' || !body.recommendation || !Array.isArray(body.alternatives)) return;
        this.setData({ recommendation: body.recommendation, alternatives: uniquePlans(body.alternatives).slice(0, 2), alternativePool: uniquePlans(body.alternatives) });
      }
    });
  },

  chooseAlternative(event) {
    if (this.data.alternativeBusy) return;
    const found = this.data.alternatives.find((item) => item.name === event.currentTarget.dataset.name);
    if (found && this.data.conversation) {
      this.setData({ alternativeBusy: true });
      wx.cloud.callFunction({ name: 'mcd-token', data: { action: 'conversation-select', conversationId: this.data.conversation.id, revision: this.data.conversation.revision, planId: found.id },
        success: response => {
          const result = response && response.result;
          this.setData({ alternativeBusy: false });
          if (result && result.ok && result.recommendation) this.applyMealResult(result);
          else wx.showToast({ title: '方案已变化，请刷新后选择', icon: 'none' });
        }, fail: () => { this.setData({ alternativeBusy: false }); wx.showToast({ title: '替换失败，请重试', icon: 'none' }); } });
      return;
    }
    const selected = found && Object.assign({}, found, { reason: found.agentReason || found.reason });
    if (!selected) return;
    const selectedKey = planKey(selected);
    const pool = uniquePlans([this.data.recommendation].concat(this.data.alternativePool || [], this.data.alternatives || []))
      .filter((item) => planKey(item) !== selectedKey);
    const alternatives = pool.slice(0, 2);
    this.setData({ recommendation: selected, alternatives, alternativePool: pool, agentExplanation: '', orderDraft: makeOrderDraft(selected, this.data.locationLabel, this.data.selectedStore) });
    wx.showToast({ title: '已替换推荐', icon: 'success' });
  },

  applyPreferences(preferences) {
    const settings = preferences.enabled && preferences.settings ? preferences.settings : { budgetMax: 40, mood: 'balanced', dietary: [], exclusions: [] };
    this.setData({ preferences, preferencesReady: true, preferencesBusy: false, preferencesDirty: false,
      memoryAgreed: preferences.enabled === true, memoryStatus: preferences.enabled ? '已保存并用于新一轮选餐' : (preferences.saved ? '已停用，保存的偏好仍可删除' : '未保存偏好'),
      preferenceBudgetInput: settings.budgetMax === null ? '' : String(settings.budgetMax), preferenceBudgetValid: true,
      agentSettings: Object.assign({}, this.data.agentSettings, { budgetMax: settings.budgetMax,
        budget: settings.budgetMax === 25 ? 'light' : settings.budgetMax === 40 ? 'standard' : settings.budgetMax === null ? 'free' : 'custom',
        mood: settings.mood, dietary: (settings.dietary || []).join('、') || '未设置', exclusions: (settings.exclusions || []).join('、') || '未设置' }) });
  },

  refreshPreferences() {
    if (this.data.preferencesBusy) return;
    const requestId = this._preferencesReadId = (this._preferencesReadId || 0) + 1;
    wx.cloud.callFunction({ name: 'mcd-token', data: { action: 'preferences-get' }, success: response => {
      if (requestId !== this._preferencesReadId) return;
      const result = response && response.result;
      if (result && result.ok && result.preferences) {
        if (this.data.preferencesDirty) this.setData({ preferences: result.preferences, preferencesReady: true });
        else this.applyPreferences(result.preferences);
      } else this.setData({ preferencesReady: false, preferencesFeedback: '偏好读取失败，请稍后重新读取。' });
    }, fail: () => { if (requestId === this._preferencesReadId) this.setData({ preferencesReady: false, preferencesFeedback: '偏好读取失败，请稍后重试。' }); } });
  },

  toggleMemory(event) {
    if (this.data.preferencesBusy) return;
    const next = event && event.detail && typeof event.detail.value === 'boolean' ? event.detail.value : !this.data.memoryAgreed;
    if (next) { this.setData({ memoryAgreed: true, preferencesDirty: true, memoryStatus: '已同意保存；点击保存后写入账号' }); return; }
    if (!this.data.preferences.enabled) { this.setData({ memoryAgreed: false, memoryStatus: '尚未保存偏好' }); return; }
    this.writePreferences('preferences-disable', { revision: this.data.preferences.revision }, true);
  },

  writePreferences(action, data, resetConversation) {
    if (this.data.preferencesBusy) return;
    this._preferencesReadId = (this._preferencesReadId || 0) + 1;
    this.setData({ preferencesBusy: true, preferencesFeedback: '' });
    wx.cloud.callFunction({ name: 'mcd-token', data: Object.assign({ action }, data), success: response => {
      const result = response && response.result;
      if (result && result.ok && result.preferences) {
        this.applyPreferences(result.preferences);
        if (resetConversation) this.newConversation();
        this.setData({ preferencesFeedback: action === 'preferences-delete' ? '保存的偏好已删除，本轮上下文已重置。' : action === 'preferences-disable' ? '已停止使用保存偏好，新一轮使用默认设置。' : '偏好已保存，下次进入会自动恢复。' });
      } else this.setData({ preferencesBusy: false, memoryAgreed: this.data.preferences.enabled, preferencesFeedback: result && result.error || '偏好操作失败，请重试。' });
    }, fail: () => this.setData({ preferencesBusy: false, memoryAgreed: this.data.preferences.enabled, preferencesFeedback: '未收到保存结果，请重新读取后核对。' }) });
  },

  savePreferences() {
    if (!this.data.memoryAgreed || !this.data.preferencesReady || !this.data.preferenceBudgetValid) return;
    const settings = this.data.agentSettings;
    this.writePreferences('preferences-save', { consent: true, revision: this.data.preferences.revision,
      settings: { budgetMax: settings.budgetMax, mood: settings.mood,
        dietary: settings.dietary === '未设置' ? [] : settings.dietary.split(/[、,，]/).map(x => x.trim()).filter(Boolean),
        exclusions: settings.exclusions === '未设置' ? [] : settings.exclusions.split(/[、,，]/).map(x => x.trim()).filter(Boolean) } }, false);
  },

  saveConversationPreferences() {
    if (!this.data.memoryAgreed || !this.data.preferencesReady || !this.data.conversation) return;
    this.writePreferences('preferences-save', { consent: true, revision: this.data.preferences.revision,
      conversationId: this.data.conversation.id, conversationRevision: this.data.conversation.revision }, false);
  },

  deletePreferences() {
    if (this.data.preferencesBusy || !this.data.preferences.saved) return;
    wx.showModal({ title: '删除保存的偏好', content: '会删除账号中的选餐偏好并重置本轮上下文。已有订单不受影响。', confirmText: '删除',
      success: result => { if (result.confirm) this.writePreferences('preferences-delete', { confirmed: true }, true); } });
  },

  copyPreferences() {
    const saved = this.data.preferences;
    if (!saved.saved || !saved.settings) return;
    wx.setClipboardData({ data: JSON.stringify({ enabled: saved.enabled, settings: saved.settings, savedAt: saved.savedAt }, null, 2) });
  },

  onPreferenceBudgetInput(event) {
    const value = String(event.detail.value || '').trim();
    const valid = value === '' || /^\d+(?:\.\d{0,2})?$/.test(value) && Number(value) <= 5000;
    const update = { preferenceBudgetInput: value, preferenceBudgetValid: valid, preferencesDirty: true, preferencesFeedback: valid ? '' : '请输入 0 到 5000 的预算，最多两位小数。' };
    if (valid) update.agentSettings = Object.assign({}, this.data.agentSettings, { budgetMax: value === '' ? null : Number(value), budget: 'custom' });
    this.setData(update);
  },

  setAgentSetting(event) {
    const key = event.currentTarget.dataset.key;
    const value = event.currentTarget.dataset.value;
    const agentSettings = Object.assign({}, this.data.agentSettings, { [key]: value });
    if (key === 'budget') agentSettings.budgetMax = value === 'light' ? 25 : value === 'standard' ? 40 : null;
    this.setData({ agentSettings, preferencesDirty: true, preferenceBudgetValid: true,
      preferenceBudgetInput: agentSettings.budgetMax === null ? '' : String(agentSettings.budgetMax), memoryStatus: '新一轮选餐生效；尚未保存此次修改' });
  },

  onAgentSettingInput(event) {
    const key = event.currentTarget.dataset.key;
    const value = String(event.detail.value || '').trim() || '未设置';
    this.setData({ agentSettings: Object.assign({}, this.data.agentSettings, { [key]: value }), preferencesDirty: true });
  },

  openProviderSettings() {
    this.clearProviderKey();
    this._providerDrafts = {};
    this.setData({ providerReturnStage: this.data.stage, stage: 'provider',
      providerSettings: Object.assign({}, this.data.activeProvider), providerDirty: false, providerFeedback: '' });
    this.refreshProviderStatus();
  },

  closeProviderSettings() {
    if (this.data.providerBusy) return;
    this.clearProviderKey();
    this.setData({ stage: this.data.providerReturnStage || 'home', providerDirty: false });
  },

  selectProvider(event) {
    if (this.data.providerBusy) return;
    const provider = event.currentTarget.dataset.provider;
    if (!['hunyuan-v3', 'openai-compatible'].includes(provider) || provider === this.data.providerSettings.provider) return;
    this._providerDrafts = this._providerDrafts || {};
    this._providerDrafts[this.data.providerSettings.provider] = this.data.providerSettings;
    const next = this._providerDrafts[provider] || (this.data.activeProvider.provider === provider
      ? this.data.activeProvider : providerView({ provider }));
    this.clearProviderKey();
    this.setData({ providerSettings: Object.assign({}, next), providerDirty: true, providerFeedback: '选择尚未生效，请保存后使用。' });
  },

  onProviderSettingInput(event) {
    if (this.data.providerBusy) return;
    const key = event.currentTarget.dataset.key;
    if (!['model', 'baseUrl'].includes(key)) return;
    const value = String(event.detail.value || '');
    const next = Object.assign({}, this.data.providerSettings, { [key]: value });
    if (key === 'baseUrl') next.apiKeyConfigured = value.trim() === this.data.activeProvider.baseUrl && this.data.activeProvider.apiKeyConfigured;
    this.setData({ providerSettings: next, providerDirty: true, providerFeedback: '' });
  },

  onProviderApiKeyInput(event) {
    if (this.data.providerBusy) return;
    this._providerApiKey = String(event.detail.value || '');
    this.setData({ providerKeyEmpty: !this._providerApiKey.trim(), providerDirty: true, providerFeedback: '' });
  },

  clearProviderKey() {
    this._providerApiKey = '';
    this.setData({ providerKeyVersion: this.data.providerKeyVersion + 1, providerKeyEmpty: true });
  },

  refreshProviderStatus() {
    if (this.data.providerBusy) return;
    const app = typeof getApp === 'function' ? getApp() : null;
    if (!app || !app.globalData || !app.globalData.cloudEnabled || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return;
    const requestId = this._providerReadId = (this._providerReadId || 0) + 1;
    wx.cloud.callFunction({
      name: 'mcd-token',
      data: { action: 'provider-status' },
      success: (response) => {
        if (requestId !== this._providerReadId) return;
        const result = response && response.result;
        if (!result || !result.ok || !result.provider) {
          this.setData({ providerReady: false, providerFeedback: '暂时无法读取当前供应商，请点“重新读取”。' });
          return;
        }
        const activeProvider = providerView(result.provider);
        const update = { activeProvider, providerReady: true, cloudIdentityReady: true };
        if (!this.data.providerDirty) update.providerSettings = Object.assign({}, activeProvider);
        this.setData(update);
      },
      fail: () => {
        if (requestId === this._providerReadId) this.setData({ providerReady: false, providerFeedback: '读取供应商失败，请点“重新读取”。' });
      }
    });
  },

  saveProviderSettings() {
    if (this.data.providerBusy) return;
    const settings = this.data.providerSettings || {};
    const provider = settings.provider === 'openai-compatible' ? 'openai-compatible' : 'hunyuan-v3';
    const model = String(settings.model || '').trim() || (provider === 'hunyuan-v3' ? 'hy3-preview' : '');
    const baseUrl = String(settings.baseUrl || '').trim();
    const apiKey = String(this._providerApiKey || '').trim();
    if (provider === 'openai-compatible' && (!model || !/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(baseUrl))) {
      this.setData({ providerFeedback: '请填写模型名和有效的 HTTPS 接口地址。' });
      return;
    }
    if (provider === 'openai-compatible' && !apiKey && !settings.apiKeyConfigured) {
      this.setData({ providerFeedback: '首次使用自定义接口需要填写 API Key。' });
      return;
    }
    const app = typeof getApp === 'function' ? getApp() : null;
    if (!app || !app.globalData || !app.globalData.cloudEnabled || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      this.setData({ providerFeedback: '微信身份服务暂不可用，请先完成微信登录。' });
      return;
    }
    this._providerReadId = (this._providerReadId || 0) + 1;
    this.setData({ providerBusy: true, providerFeedback: '正在保存并切换…' });
    this.clearProviderKey();
    const failed = (uncertain) => {
      this.setData({ providerBusy: false, providerFeedback: uncertain ? '未收到保存结果，正在重新核对。密钥输入已清空。' : '保存失败，当前供应商未切换。请重试；密钥需重新填写。' });
      if (uncertain) {
        this.setData({ providerReady: false });
        this.refreshProviderStatus();
      }
    };
    wx.cloud.callFunction({
      name: 'mcd-token',
      data: { action: 'provider-save', provider, model, baseUrl, apiKey },
      success: (response) => {
        const result = response && response.result;
        if (result && result.ok && result.provider) {
          const activeProvider = providerView(result.provider);
          this.setData({
            providerBusy: false,
            providerReady: true, providerDirty: false, activeProvider,
            providerFeedback: '已保存并切换，下次 Agent 请求将使用此供应商。',
            providerSettings: Object.assign({}, activeProvider)
          });
          this._providerDrafts = {};
        } else {
          failed(Boolean(result && result.ok));
        }
      },
      fail: () => failed(true)
    });
  },

  toggleDetailedReason() {
    const agentSettings = Object.assign({}, this.data.agentSettings, { detailedReason: !this.data.agentSettings.detailedReason });
    this.setData({ agentSettings });
  },

  onTokenInput(event) {
    // Keep the credential only in this page instance; never persist or log it.
    this._tokenValue = String(event.detail.value || '');
    this.setData({ tokenInputEmpty: !this._tokenValue.trim(), tokenFeedback: '' });
  },

  clearTokenInput() {
    this._tokenValue = '';
    this.setData({ tokenInputVersion: this.data.tokenInputVersion + 1, tokenInputEmpty: true, tokenBusy: false, tokenFeedback: '' });
  },

  onHide() { this.clearTokenInput(); this.clearProviderKey(); },
  onUnload() {
    this._agentRequestId = (this._agentRequestId || 0) + 1;
    this._officialNavigationId = (this._officialNavigationId || 0) + 1;
    this._testAccountRequestId = (this._testAccountRequestId || 0) + 1;
    this.clearTokenInput(); this.clearProviderKey();
  },

  submitToken() {
    const token = String(this._tokenValue || '').trim();
    if (!token || this.data.tokenBusy) return;
    const app = typeof getApp === 'function' ? getApp() : null;
    if (!app || !app.globalData || !app.globalData.cloudEnabled || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      this.clearTokenInput();
      this.setData({ tokenFeedback: '安全链接服务当前不可用，请稍后重试。' });
      return;
    }
    this.setData({ tokenBusy: true, tokenFeedback: '正在验证，只调用只读 MCP 工具…' });
    wx.cloud.callFunction({
      name: 'mcd-token',
      data: { action: 'bind', token },
      success: (response) => {
        const result = response && response.result;
        if (result && result.ok && result.status === 'active') {
          this.setData({ tokenLinked: true, tokenStatus: '已链接 · 本人 MCP 账号', tokenFeedback: '验证成功，Token 已安全链接。' });
        } else if (result && result.status === 'active') {
          this.setData({ tokenStatus: '已链接 · 原绑定仍保留', tokenFeedback: '新 Token 验证失败，原有链接未被替换。' });
        } else if (result && result.error === 'CloudBase user identity is required') {
          this.setData({ tokenFeedback: '小程序用户身份未传递，请刷新并重新编译后再试。' });
        } else if (result && typeof result.message === 'string' && result.message) {
          this.setData({ tokenFeedback: `Token 验证失败：${result.message}` });
        } else {
          this.setData({ tokenFeedback: 'Token 验证失败，未保存凭据。' });
        }
      },
      fail: () => {
        this.setData({ tokenFeedback: '安全验证失败，未保存凭据。' });
      },
      complete: () => {
        this._tokenValue = '';
        this.setData({ tokenInputVersion: this.data.tokenInputVersion + 1, tokenInputEmpty: true, tokenBusy: false });
      }
    });
  },

  disconnectToken() {
    this.updateTokenLifecycle('disconnect', '断开后，麦麦管家将停止使用并清除已保存的 Token。确定断开吗？', '链接已断开；之后不会读取该 Token。');
  },

  deleteToken() {
    this.updateTokenLifecycle('delete', '删除后会移除这条麦当劳 MCP 链接，之后需要重新粘贴 Token。确定删除吗？', '链接已删除，Token 不再保留。');
  },

  updateTokenLifecycle(action, message, successMessage) {
    const app = typeof getApp === 'function' ? getApp() : null;
    if (!app || !app.globalData || !app.globalData.cloudEnabled || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      this.setData({ tokenFeedback: '安全链接服务当前不可用，请稍后重试。' });
      return;
    }
    const run = () => {
      this.setData({ tokenBusy: true, tokenFeedback: '正在更新链接状态…' });
      wx.cloud.callFunction({
        name: 'mcd-token',
        data: { action },
        success: (response) => {
          const result = response && response.result;
          if (result && result.ok) {
            this.setData({
              tokenLinked: false,
              tokenStatus: action === 'disconnect' ? '已断开 · Token 未被读取' : '未链接 · 本人 MCP 账号',
              tokenFeedback: successMessage
            });
          } else {
            this.setData({ tokenFeedback: (result && result.error) || '链接状态更新失败，请稍后重试。' });
          }
        },
        fail: () => this.setData({ tokenFeedback: '安全链接服务暂时不可用，请稍后重试。' }),
        complete: () => this.setData({ tokenBusy: false })
      });
    };
    if (typeof wx.showModal !== 'function') {
      run();
      return;
    }
    wx.showModal({ title: action === 'disconnect' ? '断开链接' : '删除链接', content: message, confirmText: '继续', success: (res) => { if (res.confirm) run(); } });
  },

  showTokenNotice() {
    this.openConnection();
  },

  backToQuestion() {
    this.setData({ stage: 'question', questionIndex: 0, currentQuestion: QUESTIONS[0], progress: 33 });
  },

  restart() {
    this.newConversation();
    this._storeQueryId = (this._storeQueryId || 0) + 1;
    this.setData({ storeConfirmed: false });
    this.setData({ stage: 'location', showCityPicker: false, selectedCity: '', stores: [], storesLoading: false, storesError: '', selectedStore: null, selectedStorePoint: null, locationInfo: null, hasLocation: false, locationKeyword: '', locationStatus: '', storePoints: {}, mapCenter: null, mapMarkers: [], mapHint: '', questionIndex: 0, currentQuestion: QUESTIONS[0], progress: 33, answers: {}, alternatives: [FIXTURE_RECOMMENDATIONS.light, FIXTURE_RECOMMENDATIONS.value], alternativePool: [FIXTURE_RECOMMENDATIONS.light, FIXTURE_RECOMMENDATIONS.value], agentFeedback: '', agentExplanation: '' });
  }
});
