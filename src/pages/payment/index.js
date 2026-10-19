Page({
  data: { url: '', loading: true, error: '', copyBusy: false, copied: false },
  onLoad(options) {
    const id = options && options.id;
    if (typeof id !== 'string' || !/^checkout_[a-zA-Z0-9_-]+$/.test(id)) { this.setData({ loading: false, error: '订单标识无效，请返回订单页' }); return; }
    this._checkoutId = id;
    this.loadPayment();
  },
  loadPayment() {
    if (!this._checkoutId) return;
    const requestId = this._requestId = (this._requestId || 0) + 1;
    this.setData({ loading: true, error: '', copied: false });
    wx.cloud.callFunction({ name: 'mcd-token', data: { action: 'order-payment', checkoutId: this._checkoutId },
      success: response => {
        if (requestId !== this._requestId) return;
        const result = response && response.result;
        if (result && result.ok && /^https:\/\//.test(result.url || '')) this.setData({ loading: false, url: result.url });
        else this.setData({ loading: false, error: result && result.error || '当前无法打开付款页，请返回核对状态' });
      }, fail: () => { if (requestId === this._requestId) this.setData({ loading: false, error: '付款页暂不可用，请到麦当劳官方 App 查看订单' }); } });
  },
  onPaymentError() { this.setData({ url: '', loading: false, error: '微信暂不能打开此官方页面，请在麦当劳官方 App 完成付款，再返回刷新状态' }); },
  copyOfficialLink() {
    if (this.data.copyBusy || !this._checkoutId) return;
    this.setData({ copyBusy: true, copied: false });
    const requestId = this._requestId = (this._requestId || 0) + 1;
    wx.cloud.callFunction({ name: 'mcd-token', data: { action: 'order-payment', checkoutId: this._checkoutId }, success: response => {
      if (requestId !== this._requestId) return;
      const result = response && response.result;
      if (!result || !result.ok || !/^https:\/\//.test(result.url || '')) { this.setData({ copyBusy: false, error: result && result.error || '付款链接暂不可用，请返回刷新订单状态' }); return; }
      wx.setClipboardData({ data: result.url, success: () => this.setData({ copyBusy: false, copied: true }), fail: () => this.setData({ copyBusy: false, error: '复制失败，请到麦当劳官方 App 查看订单' }) });
    }, fail: () => { if (requestId === this._requestId) this.setData({ copyBusy: false, error: '无法获取付款链接，请返回刷新订单状态' }); } });
  },
  onUnload() { this._requestId = (this._requestId || 0) + 1; this._checkoutId = ''; },
  goBack() { wx.navigateBack(); }
});
