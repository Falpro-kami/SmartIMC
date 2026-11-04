const config = require('../config/cloud');
const cache = require('./session-cache');
const { cloudError } = require('./sharing-errors');
async function call(action, data = {}) {
  if (!getApp().globalData.cloudReady) throw new Error('云开发尚未准备好，请重新打开小程序。');
  let response;
  try { response = await wx.cloud.callFunction({ name: config.sharingFunction, data: { ...data, action }, config: { timeout: 60000 } }); }
  catch (cause) { const error = cloudError(cause); console.error('Weekly sharing call failed', action, error.code, error.sourceCode); throw error; }
  const result = response.result;
  if (!result || !result.ok) { const error = new Error(result && result.message || '每周分享服务暂时不可用。'); error.code = result && result.code; throw error; }
  if (['saveTask', 'setArchived', 'submit', 'review', 'importRoster'].includes(action)) cache.publish(['home', 'weekly', 'approvals', 'messages']);
  return result;
}
const newId = () => {
  const bytes = new Uint8Array(16);
  // request IDs are only for deduplicating retries; authorization always comes from the server.
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
};
function dateLabel(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '); }
function monday(value) {
  const day = value ? new Date(value + 'T00:00:00+08:00').getTime() : Date.now();
  const local = new Date(day + 8 * 3600000), offset = (local.getUTCDay() + 6) % 7;
  return new Date(local.getTime() - offset * 86400000).toISOString().slice(0, 10);
}
const monthKey = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 7);
function shiftMonth(month, step) {
  const [year, number] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, number - 1 + step, 1)).toISOString().slice(0, 7);
  return /^20\d{2}-/.test(next) ? next : month;
}
function calendar(month, tasks, selectedWeek = '', now = Date.now()) {
  const firstDate = month + '-01', firstMonday = Date.parse(monday(firstDate) + 'T00:00:00+08:00');
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10), current = monday(today);
  const weeks = new Map(tasks.map(task => [task.weekStart, task]));
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstMonday + index * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
    const weekStart = monday(date), task = weeks.get(weekStart), active = weekStart === (selectedWeek || current);
    return { date, day: Number(date.slice(8)), weekStart, hasTask: !!task, showDot: !!task && index % 7 === 0,
      classes: [date.slice(0, 7) !== month ? 'outside-month' : '', date === today ? 'is-today' : '', active ? 'in-week' : '',
        active && index % 7 === 0 ? 'range-start' : '', active && index % 7 === 6 ? 'range-end' : ''].filter(Boolean).join(' '),
      dotClass: task && task.status || '' };
  });
  return { label: month.slice(0, 4) + ' 年 ' + Number(month.slice(5)) + ' 月', days, isCurrentMonth: month === monthKey(now) };
}
const fileView = file => ({ ...file, sizeLabel: file.size < 1024 * 1024 ? Math.ceil(file.size / 1024) + ' KB' : (file.size / 1024 / 1024).toFixed(1) + ' MB' });
const taskView = task => ({ ...task,
  current: !!task.weekStart && task.weekStart <= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) && task.endDate >= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
  monthLabel: task.weekStart ? Number(task.weekStart.slice(5, 7)) + '月' : '', dayLabel: task.weekStart ? task.weekStart.slice(8) : '',
  rangeLabel: task.weekStart && task.endDate ? (task.weekStart.slice(0, 4) !== new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 4) ? task.weekStart.slice(0, 4) + ' · ' : '') + task.weekStart.slice(5).replace('-', '.') + ' — ' + task.endDate.slice(5).replace('-', '.') : '',
  statusLabel: { pending: '待完成', completed: '已完成', incomplete: '未完成' }[task.status],
  reviewLabel: { none: '待上传', pending: '待审批', approved: '已通过', rejected: '需修改' }[task.reviewState],
  reminderLabel: task.reminderMs ? dateLabel(task.reminderMs) : '',
  archivedLabel: task.archivedMs ? dateLabel(task.archivedMs) : '',
  ...(task.submission ? { submission: { ...task.submission, files: task.submission.files.map(fileView), submittedLabel: dateLabel(task.submission.submittedMs),
    reviewedLabel: task.submission.reviewedMs ? dateLabel(task.submission.reviewedMs) : '' } } : {}) });
function sortTasks(tasks) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const group = task => task.current ? 0 : task.weekStart > today ? 1 : 2;
  return tasks.slice().sort((a, b) => group(a) - group(b) || (group(a) === 1 ? a.weekStart.localeCompare(b.weekStart) : b.weekStart.localeCompare(a.weekStart)));
}
async function upload(file, taskId, kind = 'document') {
  const prepared = await call('prepareUpload', { taskId, name: file.name, size: file.size, kind });
  const uploaded = await wx.cloud.uploadFile({ cloudPath: prepared.cloudPath, filePath: file.path });
  const result = await call('finishUpload', { fileId: prepared.id, fileID: uploaded.fileID });
  return fileView(result.file);
}
const fsCall = (method, data) => new Promise((resolve, reject) => wx.getFileSystemManager()[method]({ ...data, success: resolve, fail: reject }));
async function chooseCover() {
  const selected = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] });
  let path = selected.tempFiles[0].tempFilePath;
  const info = await wx.getImageInfo({ src: path });
  const ext = info.type === 'png' ? 'png' : ['jpg', 'jpeg'].includes(info.type) ? 'jpg' : '';
  if (!ext) throw new Error('请选择 JPG 或 PNG 封面。');
  if (ext === 'jpg') {
    try { const compressed = await wx.compressImage({ src: path, quality: 65 }); path = compressed.tempFilePath; } catch (_) {}
  }
  const result = await fsCall('stat', { path });
  if (result.stats.size > 2 * 1024 * 1024) throw new Error('封面大小不超过2MB，请选择更小的图片。');
  return { path, size: result.stats.size, name: 'cover.' + ext };
}
async function download(taskId, file, onProgress) {
  const filePath = wx.env.USER_DATA_PATH + '/sharing-' + file.id + '-' + newId() + '.' + file.ext;
  let offset = 0;
  await fsCall('writeFile', { filePath, data: '' });
  try {
    while (offset < file.size) {
      const result = await call('downloadChunk', { taskId, fileId: file.id, offset });
      const bytes = wx.base64ToArrayBuffer(result.data);
      if (result.total !== file.size || !Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset || result.nextOffset > file.size ||
        bytes.byteLength !== result.nextOffset - offset || result.complete !== (result.nextOffset === file.size)) throw new Error('文件下载校验失败，请重试。');
      await fsCall('appendFile', { filePath, data: bytes });
      offset = result.nextOffset;
      if (onProgress) onProgress(Math.floor(offset * 100 / file.size));
    }
    return filePath;
  } catch (error) { await removeLocal(filePath); throw error; }
}
async function removeLocal(filePath) { try { await fsCall('unlink', { filePath }); } catch (_) {} }
module.exports = { call, newId, dateLabel, monday, monthKey, shiftMonth, calendar, fileView, taskView, sortTasks, chooseCover, upload, download, removeLocal,
  subscribe: listener => cache.subscribe('weekly', listener), subscribeMembers: listener => cache.subscribe('members', listener) };
