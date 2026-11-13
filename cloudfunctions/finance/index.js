const cloud = require('wx-server-sdk');
const access = require('./access');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
const storage = require('./storage')(cloud);
const env = process.env.TCB_ENV || process.env.SCF_NAMESPACE;
const prefix = process.env.FINANCE_STORAGE_PREFIX || (env === 'well-leopon-d5glrufc6e4fd4413'
  ? 'cloud://well-leopon-d5glrufc6e4fd4413.7765-well-leopon-d5glrufc6e4fd4413-1516940081/' : '');
const service = require('./service')(db, storage, access, { studentOnly: true, studentSubmit: !!prefix, financeDesk: true, prefix,
  makeArchive: (...args) => require('./archive')(...args) });
exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  const id = access.identity(context);
  try {
    if (!id) return { ok: false, code: 'AUTH_REQUIRED', message: '请从 IMC 小程序中操作。' };
    return await service.dispatch(id, event);
  } catch (error) {
    if (error.businessCode) return { ok: false, code: error.businessCode, message: error.message };
    console.error('Finance operation failed', error.errCode || error.code || error.name);
    return { ok: false, code: 'FINANCE_FAILED', message: '财务报销服务暂时不可用，请重试。' };
  }
};
