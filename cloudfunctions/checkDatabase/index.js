const cloud = require('wx-server-sdk');
const access = require('./access');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const collectionName = 'equipment';

exports.main = async () => {
  try {
    const id = access.identity(cloud.getWXContext());
    if (!id) return { ok: false, code: 'AUTH_REQUIRED', message: '请从 IMC 小程序中操作。' };
    if (!access.allowed(await access.readMember(db, id), 'equipment.read')) return { ok: false, code: 'MEMBERSHIP_REQUIRED', message: '通过 IMC 成员审核后才能访问。' };
    // Only read one record ID to verify access. Never return equipment records.
    await db.collection(collectionName).field({ _id: true }).limit(1).get();

    return {
      ok: true,
      collection: collectionName,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    const code = String(error.errCode || error.code || 'DATABASE_CHECK_FAILED');
    const detail = String(error.errMsg || error.message || '');
    const missingCollection = /collection.*(?:not exist|not found)|DATABASE_COLLECTION_NOT_EXIST|集合不存在/i.test(detail);

    console.error('Database check failed:', code, detail);

    return {
      ok: false,
      code,
      collection: collectionName,
      message: missingCollection
        ? '尚未找到 equipment 集合，请在云数据库中创建该集合后重试。'
        : '数据库查询未成功，请检查环境关联、数据库状态和云函数日志。'
    };
  }
};
