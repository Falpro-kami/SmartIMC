const cloud = require('wx-server-sdk');
const access = require('./access');
const { createService } = require('./service');
const ENV = 'well-leopon-d5glrufc6e4fd4413';
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
exports.main = async (event = {}) => {
  const id = access.identity(cloud.getWXContext());
  if (!id) return { ok: false, code: 'AUTH_REQUIRED', message: '请从 IMC 小程序中操作。' };
  let resourcePromise;
  const resources = () => resourcePromise || (resourcePromise = Promise.resolve().then(() => {
    const CloudBase = require('@cloudbase/manager-node');
    const manager = new CloudBase({ envId: ENV, region: 'ap-shanghai', timeout: 15000 });
    return { manager, api: (Action, body = {}) => manager.commonService('tcb').call({ Action, Param: { EnvId: ENV, ...body } }) };
  }));
  try { return await createService({ db, cloud, access, resources, envId: ENV })(id, event); }
  catch (error) {
    if (error.businessCode) return { ok: false, code: error.businessCode, message: error.message };
    console.error('Admin data operation failed:', error.code || 'ADMIN_DATA_FAILED');
    return { ok: false, code: 'ADMIN_DATA_FAILED', message: '备份或到期信息暂时不可用，请稍后重试。' };
  }
};
