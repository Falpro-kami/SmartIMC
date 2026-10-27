const cloud = require('wx-server-sdk');
const access = require('./access');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const APP_ID = 'wx875c04f31134c779';
const FIELDS = ['_id', 'sequence', 'equipmentNumber', 'name', 'inventoryNumber',
  'model', 'status', 'user', 'location', 'custodian', 'registeredDate', 'checkedDate',
  'image', 'notes', 'ledger', 'sortOrder'];

function present(record) {
  return Object.fromEntries(FIELDS.map(key => [key, record[key] === undefined ? '' : record[key]]));
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  // Trust only the platform identity, never an appid/openid supplied in event data.
  if (!context.OPENID || context.APPID !== APP_ID) {
    return { ok: false, code: 'AUTH_REQUIRED', message: '请从实验室小程序中打开设备管理。' };
  }
  try {
    const member = await access.readMember(db, access.identity(context));
    if (!access.allowed(member, 'equipment.read')) {
      return { ok: false, code: 'MEMBERSHIP_REQUIRED', message: '请先到“我的”申请加入 IMC，并等待管理员审核。已停用账号请联系管理员。' };
    }
    const collection = db.collection('equipment');
    if (event.action === 'detail') {
      if (typeof event.id !== 'string' || !/^eq_[a-f0-9]{24}$/.test(event.id)) {
        return { ok: false, code: 'INVALID_ID', message: '设备编号不正确。' };
      }
      const result = await collection.where({ _id: event.id }).limit(1).get();
      if (!result.data.length) return { ok: false, code: 'NOT_FOUND', message: '这条设备记录已不存在，请刷新列表。' };
      return { ok: true, record: present(result.data[0]) };
    }
    if (event.action !== 'list') return { ok: false, code: 'INVALID_ACTION', message: '不支持的操作。' };
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return { ok: false, code: 'INVALID_OFFSET', message: '分页参数不正确。' };
    }
    const result = await collection.orderBy('sortOrder', 'asc').skip(offset).limit(100).get();
    return { ok: true, records: result.data.map(present),
      nextOffset: offset + result.data.length, hasMore: result.data.length === 100 };
  } catch (error) {
    console.error('Equipment query failed:', error.errCode || error.code || '', error.message || '');
    return { ok: false, code: 'QUERY_FAILED', message: '暂时无法读取设备清单，请稍后重试。' };
  }
};
