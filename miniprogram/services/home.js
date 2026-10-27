const config = require('../config/cloud');
const cache = require('./session-cache');
async function call(data) {
  if (!getApp().globalData.cloudReady) throw new Error('云开发尚未准备好，请重新打开小程序。');
  const { result } = await wx.cloud.callFunction({ name: config.accessFunction, data });
  if (!result || !result.ok) {
    const error = new Error(result && result.message || '团队内容读取失败，请重试。');
    error.code = result && result.code;
    throw error;
  }
  return result;
}
function dateLabel(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function present(row) { return { ...row, dateLabel: dateLabel(row.publishedMs || row.createdMs) }; }
async function mutate(data) { const result = await call(data); cache.invalidate('home:'); return result; }
module.exports = { peek: () => cache.peek('home:dashboard'),
  dashboard: (force = false) => cache.load('home:dashboard', () => call({ action: 'home' }), 30000, force),
  list: (offset, force = false) => cache.load('home:list:' + offset, () => call({ action: 'announcements', offset }), 30000, force),
  get: (id, force = false) => cache.load('home:detail:' + id, () => call({ action: 'announcement', id }), 30000, force),
  save: item => mutate({ ...item, action: 'saveAnnouncement' }),
  withdraw: item => mutate({ action: 'withdrawAnnouncement', id: item.id, revision: item.revision }), present };
