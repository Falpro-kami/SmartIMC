const config = require('../config/cloud');
const cache = require('./session-cache');
const READS = ['list', 'get', 'roster', 'configuration', 'team', 'templates'];
const cacheKey = (action, data) => 'weekly:' + action + ':' + JSON.stringify(data);
async function request(action, data = {}) {
  if (!getApp().globalData.cloudReady) throw new Error('云开发尚未准备好，请重新打开小程序。');
  let response;
  try { response = await wx.cloud.callFunction({ name: config.weeklyFunction, data: { ...data, action }, config: { timeout: 60000 } }); }
  catch (_) { throw new Error('网络连接失败，请稍后重试。'); }
  const result = response.result;
  if (!result || !result.ok) {
    const error = new Error(result && result.message || '周报服务暂时不可用，请重试。');
    error.code = result && result.code;
    throw error;
  }
  if (['savePeriod', 'saveDraft', 'submit', 'saveTemplate'].includes(action)) { cache.invalidate('weekly:'); cache.invalidate('home:'); }
  if (['savePeriod', 'saveDraft', 'submit', 'remind', 'saveTemplate'].includes(action) && cache.publish) {
    cache.publish(['home', 'weekly', ...(['savePeriod', 'remind'].includes(action) ? ['messages'] : [])]);
  }
  if (['savePeriod', 'remind'].includes(action)) {
    const access = require('./access');
    if (access.notifications) access.notifications(true).catch(() => {});
  }
  return result;
}
function call(action, data = {}, force = false) {
  return READS.includes(action) ? cache.load(cacheKey(action, data), () => request(action, data), 30000, force) : request(action, data);
}
const newId = prefix => prefix + '_' + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
function dateLabel(ms) {
  if (!ms) return '-';
  const date = new Date(ms + 8 * 3600000);
  return date.toISOString().slice(0, 16).replace('T', ' ');
}
const statusLabel = status => ({ unsubmitted: '未提交', draft: '草稿', submitted: '已提交', exempt: '免交', outside: '无需提交' }[status] || '-');
const fileView = f => ({ ...f, sizeLabel: f.size < 1024 * 1024 ? Math.ceil(f.size / 1024) + ' KB' : (f.size / 1024 / 1024).toFixed(1) + ' MB' });
const periodView = p => ({ ...p, deadlineLabel: dateLabel(p.deadlineMs), publishLabel: dateLabel(p.publishAtMs), statusLabel: p.status === 'scheduled' ? '待发布' : p.status === 'cancelled' ? '已取消' : statusLabel(p.ownStatus),
  periodLabel: { scheduled: '待发布', cancelled: '已取消发布', open: '开放中', closed: '已关闭', archived: '已归档' }[p.status] || '-' });
async function upload(file, periodId, fieldId = '', kind = 'attachment') {
  const prepared = await call('prepareUpload', { periodId, name: file.name, size: file.size, fieldId, kind });
  const uploaded = await wx.cloud.uploadFile({ cloudPath: prepared.cloudPath, filePath: file.path });
  const result = await call('finishUpload', { fileId: prepared.id, fileID: uploaded.fileID });
  return fileView(result.file);
}
const fsCall = (method, params) => new Promise((resolve, reject) => wx.getFileSystemManager()[method]({ ...params, success: resolve, fail: reject }));
async function download(fileId, versionId) {
  const result = await call('download', { fileId, versionId: versionId || '' });
  try {
    const response = await wx.downloadFile({ url: result.url });
    if (response.statusCode !== 200) throw new Error('文件下载失败');
    return { filePath: response.tempFilePath, fileName: result.file.name, ext: result.file.ext };
  } catch (_) { /* Cloud-function transfer also works when downloadFile domains have not been configured. */ }
  const filePath = wx.env.USER_DATA_PATH + '/weekly-' + fileId + '.' + result.file.ext;
  let offset = 0;
  await fsCall('writeFile', { filePath, data: '' });
  try {
    while (offset < result.file.size) {
      const chunk = await call('downloadChunk', { fileId, versionId: versionId || '', offset });
      const bytes = wx.base64ToArrayBuffer(chunk.data);
      if (chunk.total !== result.file.size || !Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset <= offset || chunk.nextOffset > result.file.size ||
        bytes.byteLength !== chunk.nextOffset - offset || chunk.complete !== (chunk.nextOffset === result.file.size)) throw new Error('文件下载校验失败，请重试。');
      await fsCall('appendFile', { filePath, data: bytes });
      offset = chunk.nextOffset;
    }
    return { filePath, fileName: result.file.name, ext: result.file.ext };
  } catch (error) {
    try { await fsCall('unlink', { filePath }); } catch (_) {}
    throw error;
  }
}
async function exportStats(periodId) {
  const result = await call('exportStats', { periodId });
  const filePath = wx.env.USER_DATA_PATH + '/weekly-statistics.csv';
  await fsCall('writeFile', { filePath, data: result.csv, encoding: 'utf8' });
  return { filePath, fileName: result.name };
}
module.exports = { call, subscribe: listener => cache.subscribe('weekly', listener), peek: (action, data = {}) => cache.peek(cacheKey(action, data)), upload, download, exportStats, newId, dateLabel, statusLabel, fileView, periodView };
