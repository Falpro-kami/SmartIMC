const cloud = require('wx-server-sdk');
const access = require('./access');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
const service = require('./service')(db, cloud, access);
const reminders = require('./reminders')(db);
const runTimer = require('./timer')(db, reminders);
exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  const id = access.identity(context);
  try {
    // APPID identifies an application, not a signed-in member. Client calls
    // always retain their trusted OPENID and cannot enter the timer branch.
    if (!context.OPENID && event.Type === 'Timer' && event.TriggerName === 'weekly-sharing-reminders') return await runTimer();
    if (!id) return { ok: false, code: 'AUTH_REQUIRED', message: '请从 IMC 小程序中操作。' };
    return await service.dispatch(id, event);
  } catch (error) {
    if (error.businessCode) return { ok: false, code: error.businessCode, message: error.message };
    console.error('Weekly sharing failed:', error.errCode || error.code || 'SHARING_FAILED');
    if (typeof event.action === 'string' && event.action.startsWith('challenge.') && require('./policy').manager(await access.readMember(db, id))) {
      const detail = String(error.message || error.code || error.name).replace(/https?:\/\/\S+/g, '[url]').replace(/(SecretKey|SecretId|SessionToken|AccessToken)[=: ]+\S+/gi, '$1=[hidden]').slice(0, 220);
      return { ok: false, code: 'CHALLENGE_SETUP_FAILED', message: '挑战赛操作失败：' + detail };
    }
    return typeof event.action === 'string' && event.action.startsWith('challenge.') ?
      { ok: false, code: 'CHALLENGE_FAILED', message: '挑战赛服务暂时不可用，请重试。' } :
      { ok: false, code: 'SHARING_FAILED', message: '每周分享服务暂时不可用，请重试。' };
  }
};
