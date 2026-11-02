const cache = require('./session-cache');
const equipment = require('./equipment');
const active = new Set(), temporary = new Set();
let clearing = null;
const knownFile = name => /^weekly-wf_[a-f0-9]{32}\.(?:pdf|docx?|png|jpe?g)$/i.test(name) || name === 'weekly-statistics.csv';
const missingFile = error => /ENOENT|no such file|not found|文件不存在/i.test(error && (error.errMsg || error.message) || '');
function root() {
  const value = wx.env && wx.env.USER_DATA_PATH;
  if (!value) throw new Error('当前微信暂不支持存储管理。');
  return value.replace(/\/$/, '');
}
function fsCall(method, params) {
  return new Promise((resolve, reject) => {
    try {
      const fs = wx.getFileSystemManager();
      if (typeof fs[method] !== 'function') throw new Error('当前微信暂不支持存储管理。');
      fs[method]({ ...params, success: resolve, fail: reject });
    } catch (error) { reject(error); }
  });
}
function remember(filePath) {
  // Only paths returned by the weekly preview download are registered here.
  if (typeof filePath === 'string' && filePath && !filePath.startsWith('cloud://') && !/\.imcbak(?:$|[?#])/i.test(filePath)) temporary.add(filePath);
}
async function withFile(filePath, task) {
  while (clearing) await clearing.catch(() => {});
  active.add(filePath);
  try { return await task(); }
  finally { active.delete(filePath); }
}
async function snapshot() {
  const directory = root(), response = await fsCall('readdir', { dirPath: directory });
  const paths = new Set([...(response.files || []).filter(knownFile).map(name => directory + '/' + name), ...temporary]);
  const files = [];
  for (const filePath of paths) {
    if (active.has(filePath)) continue;
    try {
      const result = await fsCall('stat', { path: filePath });
      if (typeof result.stats.isFile === 'function' && result.stats.isFile() && Number.isFinite(result.stats.size) && result.stats.size >= 0) files.push({ filePath, size: result.stats.size });
    } catch (error) {
      if (!missingFile(error)) throw new Error('部分缓存文件暂时无法读取，请稍后重试。');
      temporary.delete(filePath);
    }
  }
  return { files, bytes: files.reduce((sum, file) => sum + file.size, 0), count: files.length, activeCount: active.size };
}
function clear() {
  if (clearing) return clearing;
  clearing = Promise.resolve().then(async () => {
    const before = await snapshot();
    let failed = 0, removed = 0;
    for (const file of before.files) {
      if (active.has(file.filePath)) continue;
      try { await fsCall('unlink', { filePath: file.filePath }); temporary.delete(file.filePath); removed++; }
      catch (error) { if (missingFile(error)) temporary.delete(file.filePath); else failed++; }
    }
    // Do not reset membership, unread state, local preferences or editable page data.
    cache.clear();
    equipment.clearCache();
    return { removed, failed };
  }).finally(() => { clearing = null; });
  return clearing;
}
function sizeLabel(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.ceil(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
module.exports = { snapshot, clear, withFile, remember, sizeLabel };
