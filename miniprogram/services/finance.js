const config = require('../config/cloud');
const { newId, dateLabel, monday, removeLocal } = require('./sharing');
const { cloudError } = require('./sharing-errors');

const errorOptions = { service: '财务报销', prefix: 'FINANCE', contact: '小程序管理员', setup: '部署云服务' };

async function call(action, data = {}) {
  if (!getApp().globalData.cloudReady) throw new Error('云开发尚未准备好，请重新打开小程序。');
  let response;
  try {
    response = await wx.cloud.callFunction({ name: config.financeFunction, data: { ...data, action }, config: { timeout: 60000 } });
  } catch (cause) {
    const error = cloudError(cause, errorOptions);
    console.error('Finance call failed', action, error.code, error.sourceCode);
    throw error;
  }
  const result = response.result;
  if (!result || !result.ok) throw new Error(result && result.message || '财务报销服务暂时不可用。');
  return result;
}
async function upload(file, kind, claimId, naming) {
  const prepared = await call('prepare', { name: file.name, size: file.size, kind, claimId, ...naming });
  const uploaded = await wx.cloud.uploadFile({ cloudPath: prepared.cloudPath, filePath: file.path });
  const result = await call('finish', { fileId: prepared.id, fileID: uploaded.fileID });
  return result.file;
}
const fs = (method, data) => new Promise((resolve, reject) => wx.getFileSystemManager()[method]({ ...data, success: resolve, fail: reject }));
async function download(file, claimId, onProgress, active) {
  const folder = wx.env.USER_DATA_PATH + '/finance-' + newId();
  const name = file.name && !/[<>:"/\\|?*\x00-\x1f]/.test(file.name) && file.name.endsWith('.' + file.ext)
    ? file.name : '报销材料.' + file.ext;
  const filePath = folder + '/' + name;
  let offset = 0;
  await fs('mkdir', { dirPath: folder });
  try {
    await fs('writeFile', { filePath, data: '' });
    while (offset < file.size) {
      if (!active()) throw new Error('下载已取消。');
      const result = await call('chunk', { fileId: file.id, claimId, offset });
      if (!active()) throw new Error('下载已取消。');
      const bytes = wx.base64ToArrayBuffer(result.data);
      if (result.total !== file.size || !Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset ||
          result.nextOffset > file.size || result.nextOffset - offset !== bytes.byteLength) throw new Error('文件下载校验失败，请重试。');
      await fs('appendFile', { filePath, data: bytes });
      offset = result.nextOffset;
      onProgress(Math.floor(offset * 100 / file.size));
    }
    return filePath;
  } catch (error) { await removeDownload(filePath); throw error; }
}
async function removeDownload(filePath) {
  await removeLocal(filePath);
  await fs('rmdir', { dirPath: filePath.slice(0, filePath.lastIndexOf('/')) }).catch(() => {});
}
function parseAmount(amount) {
  const value = amount.trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) return 0;
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
const money = cents => (cents / 100).toFixed(2);
const fileKinds = [{ id: 'invoice', label: '电子发票' }, { id: 'payment', label: '支付记录截图' },
  { id: 'purchase', label: '购买记录截图' }, { id: 'trip', label: '行程单' }];
const fileLabel = (kind, labels) => labels?.[kind] || fileKinds.find(value => value.id === kind)?.label || '附件';
const dateText = ms => Number.isFinite(ms) && ms > 0 && ms <= 8640000000000000 - 8 * 3600000 ? dateLabel(ms) : '';
const claimView = (row, labels) => ({ ...row, amount: Number.isSafeInteger(row.cents) ? money(row.cents) : '',
  transportLabel: row.transport?.mode === 'ride' ? '网约车' : '巡游出租车',
  registered: dateText(row.createdMs), updated: row.updatedAt || dateText(row.updatedMs),
  invoiceCount: row.invoiceCount === undefined ? row.files.filter(file => file.kind === 'invoice').length : row.invoiceCount,
  label: row.reviewState === 'needs' ? '待补件' : row.reviewState === 'review' && row.stage > 0 ? '补件待核验' : row.stageLabel,
  files: row.files.map(file => ({ ...file, kindLabel: fileLabel(file.kind, labels) })) });
function groups(claims) {
  const people = new Map();
  for (const claim of claims) {
    const person = people.get(claim.ownerId) || { id: claim.ownerId, name: claim.ownerName, cents: 0, invoices: 0, submitted: 0, claims: [] };
    person.cents += Number.isSafeInteger(claim.cents) ? claim.cents : 0;
    person.invoices += claim.invoiceCount;
    if (claim.invoiceCount > 0) person.submitted++;
    person.claims.push(claim);
    people.set(person.id, person);
  }
  const nameCounts = new Map();
  for (const person of people.values()) nameCounts.set(person.name, (nameCounts.get(person.name) || 0) + 1);
  return Array.from(people.values(), person => ({ ...person, amount: money(person.cents),
    displayName: nameCounts.get(person.name) > 1 ? person.name + ' · ' + person.id.slice(-6) : person.name }));
}
module.exports = { call, upload, download, removeDownload, newId, dateLabel, monday, parseAmount, money, fileKinds, fileLabel, claimView, groups };
