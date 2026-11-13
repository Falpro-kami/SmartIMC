const baseUrl = 'https://open.feishu.cn/open-apis';
const statuses = ['', '已核验', '已制单', '已签字', '已提交财务处'];
const columns = { number: '申请编号', owner: '报销人', category: '报销分类', amount: '报销金额',
  week: '报送周', version: '材料版本', progress: '处理进度', needs: '补件要求', closed: '到账确认' };

function fieldText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => item.text || '').join('');
  return '';
}
function tokenFor(id) {
  const value = id.slice(3);
  return value.slice(0, 8) + '-' + value.slice(8, 12) + '-4' + value.slice(13, 16) + '-8' + value.slice(17, 20) + '-' + value.slice(20);
}

module.exports = function feishu(config, request = fetch, clock = Date.now) {
  const { appId, appSecret, appToken, tableId, fields = {} } = config;
  if (![appId, appSecret, appToken, tableId].every(Boolean)) return null;
  const names = { ...columns, ...fields };
  const records = '/bitable/v1/apps/' + encodeURIComponent(appToken) + '/tables/' + encodeURIComponent(tableId) + '/records';
  let token = '', expires = 0, refreshing = null, writeQueue = Promise.resolve();

  async function api(path, method, body, accessToken) {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    const response = await request(baseUrl + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(7500) });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw Object.assign(new Error('Feishu API request failed'), { code: 'FEISHU_' + (result.code || response.status) });
    return result;
  }
  async function getToken() {
    if (token && clock() < expires) return token;
    if (!refreshing) refreshing = (async () => {
      const result = await api('/auth/v3/tenant_access_token/internal', 'POST', { app_id: appId, app_secret: appSecret });
      if (typeof result.tenant_access_token !== 'string' || !Number.isFinite(result.expire)) throw new Error('Invalid Feishu token response');
      token = result.tenant_access_token;
      expires = clock() + Math.max(0, result.expire - 120) * 1000;
      return token;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function call(path, method, body) {
    const accessToken = await getToken();
    return (await api(path, method, body, accessToken)).data;
  }
  function write(path, method, fields) {
    const next = writeQueue.then(() => call(path, method, { fields }));
    writeQueue = next.catch(() => {});
    return next;
  }
  async function locate(row) {
    if (row.feishuId) {
      const result = await call(records + '/' + encodeURIComponent(row.feishuId), 'GET');
      if (fieldText(result.record.fields[names.number]) !== row._id) throw Object.assign(new Error('Record identity changed'), { code: 'FEISHU_RECORD_MISMATCH' });
      return result.record;
    }
    const result = await call(records + '/search?page_size=2', 'POST', {
      filter: { conjunction: 'and', conditions: [{ field_name: names.number, operator: 'is', value: [row._id] }] }
    });
    if (result.has_more || (result.items || []).length > 1) throw Object.assign(new Error('Duplicate claim number'), { code: 'FEISHU_DUPLICATE_CLAIM' });
    return (result.items || [])[0];
  }
  async function exchange(row) {
    let record = await locate(row);
    if (!record) {
      const initial = {
        [names.number]: row._id, [names.owner]: row.ownerName, [names.category]: row.category, [names.amount]: row.cents / 100,
        [names.week]: row.weekStart, [names.version]: row.materialVersion, [names.progress]: '已核验'
      };
      record = (await write(records + '?client_token=' + tokenFor(row._id), 'POST', initial)).record;
    }
    const changes = {};
    if ((Number(record.fields[names.version]) || 0) < row.materialVersion) changes[names.version] = row.materialVersion;
    if (row.stage === 5 && fieldText(record.fields[names.closed]) !== '已到账') changes[names.closed] = '已到账';
    if (Object.keys(changes).length) await write(records + '/' + encodeURIComponent(record.record_id), 'PUT', changes);
    const stage = statuses.indexOf(fieldText(record.fields[names.progress]).trim());
    return { id: record.record_id, stage, needs: fieldText(record.fields[names.needs]).trim().slice(0, 300) };
  }
  return { exchange };
};
