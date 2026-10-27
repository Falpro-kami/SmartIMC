const config = require('../config/cloud');
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
module.exports = { dashboard: () => call({ action: 'home' }), list: offset => call({ action: 'announcements', offset }),
  get: id => call({ action: 'announcement', id }), save: item => call({ ...item, action: 'saveAnnouncement' }),
  withdraw: item => call({ action: 'withdrawAnnouncement', id: item.id, revision: item.revision }), present };
