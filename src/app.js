App({
  onLaunch() {
    if (this.globalData.cloudEnabled && this.globalData.cloudEnvId &&
        typeof wx !== 'undefined' && wx.cloud && wx.cloud.init) {
      wx.cloud.init({
        env: this.globalData.cloudEnvId,
        traceUser: true
      });
    }
  },
  globalData: {
    appName: '麦麦管家',
    fixtureMode: true,
    // Public source starts offline. Configure your own environment to opt in.
    cloudEnabled: false,
    cloudEnvId: '',
    // Set this only in a controlled development build after HTTPS/domain setup.
    // Empty by default so the prototype never sends user data off-device.
    backendURL: ''
  }
});
