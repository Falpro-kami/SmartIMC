const config = require('../config/cloud');
const cache = require('./session-cache');
const sharing = require('./sharing');
const access = require('./access');
async function call(action, data = {}) {
  if (!getApp().globalData.cloudReady) throw new Error('云开发尚未准备好，请重新打开小程序。');
  let response;
  try { response = await wx.cloud.callFunction({ name: config.sharingFunction, data: { ...data, action: 'challenge.' + action }, config: { timeout: 60000 } }); }
  catch (cause) { const error = new Error('挑战赛服务暂时不可用，请稍后重试。'); error.code = cause.errCode; throw error; }
  const result = response.result;
  if (!result?.ok) { const error = new Error(result?.message || '挑战赛读取失败，请重试。'); error.code = result?.code; throw error; }
  if (['save', 'register', 'submit', 'publishResults', 'bindTeacher'].includes(action)) cache.publish(['home', 'weekly', 'messages']);
  return result;
}
const dateLabel = ms => sharing.dateLabel(ms);
function eventView(row) {
  return { ...row, startLabel: dateLabel(row.startMs), endLabel: dateLabel(row.endMs),
    phaseLabel: { open: '进行中', upcoming: '未开始', closed: '已截止' }[row.phase],
    cover: row.cover ? sharing.fileView(row.cover) : null, intro: row.intro ? sharing.fileView(row.intro) : null,
    results: row.results ? { ...row.results, file: sharing.fileView(row.results.file) } : null };
}
const teamView = row => ({ ...row, membersLabel: row.memberNames.join('、') || '无其他成员',
  work: row.work ? { ...row.work, file: sharing.fileView(row.work.file), uploadedLabel: dateLabel(row.work.uploadedMs) } : null });
async function upload(file, eventId, kind) {
  const prepared = await call('prepareUpload', { eventId, kind, name: file.name, size: file.size });
  const uploaded = await wx.cloud.uploadFile({ cloudPath: prepared.cloudPath, filePath: file.path });
  return sharing.fileView((await call('finishUpload', { fileId: prepared.id, fileID: uploaded.fileID })).file);
}
const fsCall = (method, data) => new Promise((resolve, reject) => wx.getFileSystemManager()[method]({ ...data, success: resolve, fail: reject }));
async function download(eventId, file, groupId = '', progress) {
  const filePath = wx.env.USER_DATA_PATH + '/challenge-' + sharing.newId() + '.' + file.ext;
  let offset = 0; await fsCall('writeFile', { filePath, data: '' });
  try {
    while (offset < file.size) {
      const result = await call('downloadChunk', { eventId, fileId: file.id, groupId, offset });
      const bytes = wx.base64ToArrayBuffer(result.data);
      if (result.total !== file.size || result.nextOffset <= offset || result.nextOffset > file.size || bytes.byteLength !== result.nextOffset - offset || result.complete !== (result.nextOffset === file.size)) throw new Error('文件下载校验失败。');
      await fsCall('appendFile', { filePath, data: bytes }); offset = result.nextOffset;
      if (progress) progress(Math.floor(offset / file.size * 100));
    }
    return filePath;
  } catch (error) { await sharing.removeLocal(filePath); throw error; }
}
async function chooseFile(kind) {
  if (kind === 'cover') return sharing.chooseCover();
  const result = await wx.chooseMessageFile({ count: 1, type: 'file', extension: kind === 'scores' ? ['csv'] : ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'] });
  const file = result.tempFiles[0], max = kind === 'scores' ? 256 * 1024 : 20 * 1024 * 1024;
  if (!file || file.size > max) throw new Error(kind === 'scores' ? 'CSV大小不超过256KB。' : '文件大小不超过20MB。');
  return { path: file.path, name: file.name, size: file.size };
}
module.exports = { call, eventView, teamView, upload, download, chooseFile, dateLabel, newId: sharing.newId, removeLocal: sharing.removeLocal,
  identityScope: access.identityScope,
  subscribe: sharing.subscribe, subscribeMembers: sharing.subscribeMembers };
