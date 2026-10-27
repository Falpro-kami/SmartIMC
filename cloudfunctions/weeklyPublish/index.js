const cloud = require('wx-server-sdk');
const access = require('./access');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const publishDue = require('./publisher')(cloud.database({ throwOnNotFound: false }), access);
exports.main = async event => {
  const context = cloud.getWXContext();
  // Timer-only worker. A caller cannot bypass membership by forging Type/TriggerName in an event.
  if (context.OPENID || context.APPID || !event || event.Type !== 'Timer' || event.TriggerName !== 'weekly-publish-minute') {
    return { ok: false, code: 'TRIGGER_ONLY' };
  }
  return publishDue();
};
