Page({
  data: { privacyFeedback: '' },

  openPrivacyContract() {
    if (typeof wx.openPrivacyContract !== 'function') {
      this.setData({ privacyFeedback: '当前微信版本无法打开隐私指引，请更新微信后重试。' });
      return;
    }
    this.setData({ privacyFeedback: '' });
    wx.openPrivacyContract({
      fail: () => this.setData({ privacyFeedback: '隐私指引暂时无法打开，请稍后重试。' })
    });
  }
});
