const config = require('../config/cloud');
const cache = require('./session-cache');
const unreadListeners = new Set();
let unread = null, unreadAt = 0, unreadRequest = null, unreadVersion = 0;
let scope = '';
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
  const version = ++unreadVersion;
  identityRequest = call({ action: 'get' }).then(result => {
    if (epoch === identityEpoch) {
      const nextScope = JSON.stringify([result.accountCode, result.member && result.member.status, result.member && result.member.revision, result.member && result.member.roles]);
      const changed = scope && scope !== nextScope;
      if (changed) cache.clear();
      scope = nextScope; identity = { ...result, hasUnread: version !== unreadVersion && unread !== null ? unread : result.hasUnread };
      if (version === unreadVersion) publishUnread(result.hasUnread === true);
      if (changed && cache.publish) cache.publish(['members']);
    }
    return result;
  })
    .finally(() => { identityRequest = null; });
  return identityRequest;
}
async function mutate(data) {
  const result = await call(data);
  identityEpoch++;
  unreadVersion++;
  identity = data.action === 'apply' ? result : null;
  if (data.action === 'readMessage') cache.invalidate('access:messages'); else cache.clear();
  if (typeof result.hasUnread === 'boolean') publishUnread(result.hasUnread);
  else unreadAt = 0;
  if (cache.publish) cache.publish(data.action === 'readMessage' ? ['messages'] : ['home', 'messages', 'approvals', 'members', 'weekly']);
  return result;
}
function publishUnread(value) {
  unread = value; unreadAt = Date.now();
  if (identity) identity = { ...identity, hasUnread: value };
  unreadListeners.forEach(listener => listener(value));
  return value;
}
function notifications(force = false) {
  if (!force && unread !== null && Date.now() - unreadAt < 5000) return Promise.resolve(unread);
  if (unreadRequest) return unreadRequest;
  const epoch = identityEpoch;
  const version = ++unreadVersion;
  unreadRequest = call({ action: 'notificationState' }).then(result => {
    if (epoch === identityEpoch && version === unreadVersion) return publishUnread(result.hasUnread === true);
    return unread;
  }).finally(() => { unreadRequest = null; });
  return unreadRequest;
}
function subscribeUnread(listener) { unreadListeners.add(listener); if (unread !== null) listener(unread); return () => unreadListeners.delete(listener); }
function refreshUnread() {
  unreadAt = 0; unreadVersion++;
  // A push received during an older read must get a second, post-commit read.
  return unreadRequest ? unreadRequest.catch(() => {}).then(() => notifications(true)) : notifications(true);
}
function refreshIdentity() {
  return identityRequest ? identityRequest.catch(() => {}).then(() => get(true)) : get(true);
}
function read(action, data, force = false) { return cache.load('access:' + action + ':' + JSON.stringify(data), () => call({ ...data, action }), 30000, force); }
module.exports = { get, refreshIdentity, apply: () => mutate({ action: 'apply' }),
  sync: action => call({ action }),
  subscribeChanges: (channel, listener) => cache.subscribe(channel, listener),
  notifications, refreshUnread, subscribeUnread, notificationCurrent: () => unread,
  peek: (action, data) => cache.peek('access:' + action + ':' + JSON.stringify(data)),
  approvals: (scope, offset, force) => read('approvals', { scope, offset }, force),
  directory: (offset, force) => read('directory', { offset }, force),
  messages: async offset => { const epoch = identityEpoch, version = ++unreadVersion;
    const result = await call({ action: 'messages', offset });
    if (epoch === identityEpoch && version === unreadVersion && typeof result.hasUnread === 'boolean') publishUnread(result.hasUnread);
    return result; },
  readMessage: id => mutate({ action: 'readMessage', id }),
  openMessage: id => call({ action: 'openMessage', id }),
  list: (offset, force) => read('list', { offset }, force),
  member: id => call({ action: 'member', id }),
  set: member => mutate({ action: 'set', id: member.id, status: member.status, roles: member.roles, revision: member.revision }), can };
