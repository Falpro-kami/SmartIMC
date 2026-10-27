const config = require('../config/cloud');
const cache = require('./session-cache');
async function call(data) {
  if (!getApp().globalData.cloudReady) throw new Error('云开发尚未准备好，请重新打开小程序。');
  const response = await wx.cloud.callFunction({ name: config.adminDataFunction, data, config: { timeout: 60000 } });
  const result = response.result;
  if (!result || !result.ok) {
    const error = new Error(result && result.message || '数据服务暂时不可用，请稍后重试。');
    error.code = result && result.code;
    throw error;
  }
  return result;
}
function expiryLabel(billing) {
  if (!billing || !Number.isFinite(billing.daysRemaining)) return '-';
  return billing.daysRemaining <= 0 ? '已到期' : '剩余 ' + billing.daysRemaining + ' 天';
}
function dateLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  const pad = number => String(number).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}
function present(record) { return { ...record, dateLabel: dateLabel(record.createdAt), sizeLabel: record.bytes < 1024 * 1024 ? Math.ceil(record.bytes / 1024) + ' KB' : (record.bytes / 1024 / 1024).toFixed(1) + ' MB' }; }
const fsCall = (name, options) => new Promise((resolve, reject) => wx.getFileSystemManager()[name]({ ...options, success: resolve, fail: reject }));
async function download(record, onProgress = () => {}) {
  if (!/^backup_[a-f0-9-]{36}$/.test(record.id || '') || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > 64 * 1024 * 1024) throw new Error('备份信息不正确。');
  const fileName = 'IMC-' + record.id + '.imcbak';
  const filePath = wx.env.USER_DATA_PATH + '/' + fileName;
  await fsCall('writeFile', { filePath, data: '' });
  let offset = 0;
  try {
    while (offset < record.bytes) {
      const result = await call({ action: 'chunk', id: record.id, offset });
      const buffer = wx.base64ToArrayBuffer(result.data);
      if (result.total !== record.bytes || !Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset || result.nextOffset > record.bytes || buffer.byteLength !== result.nextOffset - offset || result.complete !== (result.nextOffset === record.bytes)) throw new Error('备份下载校验失败。');
      await fsCall('appendFile', { filePath, data: buffer });
      offset = result.nextOffset;
      onProgress(Math.round(offset / record.bytes * 100));
    }
    return { filePath, fileName };
  } catch (error) {
    try { await fsCall('unlink', { filePath }); } catch (_) {}
    throw error;
  }
}
async function create(password) { const result = await call({ action: 'create', password }); cache.invalidate('admin:'); return result; }
module.exports = { peek: () => cache.peek('admin:status'), status: (force = false) => cache.load('admin:status', () => call({ action: 'status' }), 60000, force), create, download,
  expiryLabel, present, dateLabel };
