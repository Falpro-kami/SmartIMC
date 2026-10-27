const cloudConfig = require('./config/cloud');

App({
  globalData: {
    cloudEnvId: cloudConfig.envId,
    cloudReady: false,
    databaseStatus: 'not-checked'
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发，请升级微信或调试基础库。');
      return;
    }

    try {
      wx.cloud.init({ env: cloudConfig.envId });
      this.globalData.cloudReady = true;
      console.info('云开发已初始化，数据库访问尚未验证。');
    } catch (error) {
      console.error('云开发初始化失败：', error);
    }
  },

  async checkDatabaseConnection() {
    if (!this.globalData.cloudReady) {
      throw new Error('云开发尚未初始化成功。');
    }

    this.globalData.databaseStatus = 'checking';

    try {
      const response = await wx.cloud.callFunction({
        name: cloudConfig.databaseCheckFunction
      });
      const result = response.result;

      if (!result || typeof result.ok !== 'boolean') {
        throw new Error('数据库检测云函数返回格式不正确。');
      }

      this.globalData.databaseStatus = result.ok ? 'connected' : 'failed';
      return result;
    } catch (error) {
      this.globalData.databaseStatus = 'failed';
      throw error;
    }
  }
});
