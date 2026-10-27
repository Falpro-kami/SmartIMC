const cloud = require('wx-server-sdk');
const access = require('./access');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const service = require('./service')(cloud.database({ throwOnNotFound: false }), cloud, access);
exports.main = async (event = {}) => {
  const id = access.identity(cloud.getWXContext());
  if (!id) return { ok: false, code: 'AUTH_REQUIRED', message: '请从 IMC 小程序中操作。' };
  try { return await service.dispatch(id, event); }
  catch (error) {
    if (error.businessCode) return { ok: false, code: error.businessCode, message: error.message };
    console.error('Weekly report failed:', error.errCode || error.code || 'WEEKLY_FAILED');
    return { ok: false, code: 'WEEKLY_FAILED', message: '周报服务暂时不可用，请重试。' };
  }
};
