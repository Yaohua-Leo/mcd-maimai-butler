const LOGIN_URL = 'https://open.mcd.cn/mcp/login';

Page({
  data: { url: LOGIN_URL, failed: false },
  onWebError() {
    // Do not log external login URLs or event payloads containing account data.
    this.setData({ failed: true });
  },
  retry() { this.setData({ failed: false }); },
  copyAddress() {
    wx.setClipboardData({
      data: LOGIN_URL,
      success: () => wx.showToast({ title: '链接已复制，请在浏览器打开', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' })
    });
  },
  goBack() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) });
  }
});
