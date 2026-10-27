const config = require('../config/cloud');
let identity = null;
let identityRequest = null;
let identityEpoch = 0;
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
function get(force = false) {
  if (!force && identity) return Promise.resolve(identity);
  if (identityRequest) return identityRequest;
  const epoch = identityEpoch;
  identityRequest = call({ action: 'get' }).then(result => { if (epoch === identityEpoch) identity = result; return result; })
    .finally(() => { identityRequest = null; });
  return identityRequest;
}
async function mutate(data) {
  const result = await call(data);
  identityEpoch++;
  identity = data.action === 'apply' ? result : null;
  return result;
}
module.exports = { get, apply: () => mutate({ action: 'apply' }),
  approvals: (scope, offset) => call({ action: 'approvals', scope, offset }),
  directory: offset => call({ action: 'directory', offset }),
  messages: offset => call({ action: 'messages', offset }),
  readMessage: id => mutate({ action: 'readMessage', id }),
  openMessage: id => call({ action: 'openMessage', id }),
  list: offset => call({ action: 'list', offset }),
  member: id => call({ action: 'member', id }),
  set: member => mutate({ action: 'set', id: member.id, status: member.status, roles: member.roles, revision: member.revision }), can };
