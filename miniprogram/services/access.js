const config = require('../config/cloud');
async function call(data) {
  if (!getApp().globalData.cloudReady) throw new Error('云开发尚未准备好，请重新打开小程序。');
  const response = await wx.cloud.callFunction({ name: config.accessFunction, data });
  const result = response.result;
  if (!result || !result.ok) {
    const error = new Error(result && result.message || '成员服务返回异常，请重试。');
    error.code = result && result.code;
    throw error;
  }
  return result;
}
function can(member, permission) {
  return !!(member && member.status === 'active' && Array.isArray(member.permissions) &&
    (member.permissions.includes('*') || member.permissions.includes(permission)));
}
module.exports = { get: () => call({ action: 'get' }), apply: () => call({ action: 'apply' }),
  approvals: (scope, offset) => call({ action: 'approvals', scope, offset }),
  directory: offset => call({ action: 'directory', offset }),
  messages: offset => call({ action: 'messages', offset }),
  readMessage: id => call({ action: 'readMessage', id }),
  openMessage: id => call({ action: 'openMessage', id }),
  list: offset => call({ action: 'list', offset }),
  member: id => call({ action: 'member', id }),
  set: member => call({ action: 'set', id: member.id, status: member.status, roles: member.roles, revision: member.revision }), can };
