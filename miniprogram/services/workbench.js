const config = require('../config/cloud');
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
  return call({ action: 'workbenchUsage' });
}
function record(toolId) {
  const write = pendingWrites.then(() => call({ action: 'recordToolOpen', toolId }));
  pendingWrites = write.catch(() => {});
  return write;
}
module.exports = { load, record };
