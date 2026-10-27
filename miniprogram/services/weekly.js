const config = require('../config/cloud');
async function call(action, data = {}) {
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
  return result;
}
const newId = prefix => prefix + '_' + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
function dateLabel(ms) {
  if (!ms) return '-';
  const date = new Date(ms + 8 * 3600000);
  return date.toISOString().slice(0, 16).replace('T', ' ');
}
const statusLabel = status => ({ unsubmitted: '未提交', draft: '草稿', submitted: '已提交', exempt: '免交', outside: '无需提交' }[status] || '-');
const fileView = f => ({ ...f, sizeLabel: f.size < 1024 * 1024 ? Math.ceil(f.size / 1024) + ' KB' : (f.size / 1024 / 1024).toFixed(1) + ' MB' });
const periodView = p => ({ ...p, deadlineLabel: dateLabel(p.deadlineMs), statusLabel: statusLabel(p.ownStatus),
  periodLabel: { open: '开放中', closed: '已关闭', archived: '已归档' }[p.status] || '-' });
async function upload(file, periodId) {
  const prepared = await call('prepareUpload', { periodId, name: file.name, size: file.size });
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
module.exports = { call, upload, download, exportStats, newId, dateLabel, statusLabel, fileView, periodView };
