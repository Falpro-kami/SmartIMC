const config = require('../config/cloud');
let cache = null;
let cachedAt = 0;
let inFlight = null;

async function request(data) {
  if (!getApp().globalData.cloudReady) throw new Error('云开发尚未初始化，请重新打开小程序。');
  let response;
  try {
    response = await wx.cloud.callFunction({ name: config.equipmentFunction, data });
  } catch (cause) {
    const detail = String(cause && (cause.errMsg || cause.message) || '');
    // -601034 is rejected by WeChat before our function or its DB checks run.
    // It may be nested in errMsg while the outer errCode is -1.
    if (Number(cause && cause.errCode) === -601034 || /errCode\s*:\s*-601034\b/.test(detail)) {
      console.error('设备云服务尚未关联到当前小程序：', detail);
      const error = new Error('当前小程序尚未开通云开发，或未关联设备数据环境。请在微信开发者工具中完成开通并关联已有环境后重试（-601034）。');
      error.code = 'CLOUD_NOT_ENABLED';
      throw error;
    }
    if (cause instanceof Error) throw cause;
    throw new Error(detail || '设备服务连接失败，请稍后重试。');
  }
  const result = response.result;
  if (!result || result.ok !== true) throw new Error(result && result.message || '设备服务返回异常，请重试。');
  return result;
}

function loadAll(force = false) {
  if (inFlight) return inFlight;
  if (!force && cache && Date.now() - cachedAt < 60000) return Promise.resolve(cache);
  inFlight = (async () => {
    const records = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await request({ action: 'list', offset });
      if (!Array.isArray(page.records) || !Number.isSafeInteger(page.nextOffset) ||
          page.nextOffset !== offset + page.records.length ||
          (page.hasMore && page.nextOffset <= offset)) throw new Error('设备分页数据不完整，请重试。');
      records.push(...page.records);
      offset = page.nextOffset;
      hasMore = page.hasMore === true;
    }
    if (new Set(records.map(record => record._id)).size !== records.length) {
      throw new Error('设备清单发生变化，请下拉刷新后重试。');
    }
    cache = records;
    cachedAt = Date.now();
    return records;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

async function getDetail(id) {
  const result = await request({ action: 'detail', id });
  return result.record;
}

module.exports = { loadAll, getDetail, peek: () => cache };
