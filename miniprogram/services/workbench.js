const config = require('../config/cloud');
const cache = require('./session-cache');
let pendingWrites = Promise.resolve();
async function call(data) {
  if (!getApp().globalData.cloudReady) throw new Error('云开发尚未准备好。');
  const response = await wx.cloud.callFunction({ name: config.accessFunction, data });
  const result = response.result;
  if (!result || !result.ok) throw new Error(result && result.message || '工作台数据读取失败。');
  return result.usage;
}
async function load() {
  await pendingWrites;
  return cache.load('workbench:usage', () => call({ action: 'workbenchUsage' }), 60000);
}
function record(toolId) {
  const write = pendingWrites.then(() => call({ action: 'recordToolOpen', toolId })).then(value => { cache.set('workbench:usage', value); return value; });
  pendingWrites = write.catch(() => {});
  return write;
}
module.exports = { load, record };
