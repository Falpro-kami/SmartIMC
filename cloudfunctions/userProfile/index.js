const cloud = require('wx-server-sdk');
const { createHash } = require('node:crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const APP_ID = 'wx875c04f31134c779';
const ENV_ID = 'well-leopon-d5glrufc6e4fd4413';

function present(record) {
  return record ? { name: record.name, avatarFileId: record.avatarFileId || '' } : null;
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  if (context.APPID !== APP_ID || !context.OPENID) {
    return { ok: false, code: 'AUTH_REQUIRED', message: '请在实验室小程序中完善个人资料。' };
  }
  const id = 'user_' + createHash('sha256').update(APP_ID + ':' + context.OPENID).digest('hex').slice(0, 32);
  const avatarPrefix = 'avatars/' + id + '/';
  if (event.action !== 'get' && event.action !== 'save') {
    return { ok: false, code: 'INVALID_ACTION', message: '不支持的资料操作。' };
  }
  try {
    const collection = db.collection('userProfiles');
    if (event.action === 'get') {
      const response = await collection.where({ _id: id }).limit(1).get();
      return { ok: true, profile: present(response.data[0]), avatarPrefix };
    }
    const name = typeof event.name === 'string' ? event.name.trim() : '';
    if (!name || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name)) {
      return { ok: false, code: 'INVALID_NAME', message: '请填写姓名，最多32个字。' };
    }
    const avatarFileId = typeof event.avatarFileId === 'string' ? event.avatarFileId : '';
    if (avatarFileId) {
      const file = /^cloud:\/\/([^/]+)\/(.+)$/.exec(avatarFileId);
      if (!file || !file[1].startsWith(ENV_ID + '.') || !file[2].startsWith(avatarPrefix) ||
          file[2].includes('..') || !/^avatars\/user_[a-f0-9]{32}\/[a-zA-Z0-9_-]+\.(jpg|png|jpeg)$/.test(file[2])) {
        return { ok: false, code: 'INVALID_AVATAR', message: '头像不属于当前用户，请重新选择。' };
      }
    }
    // The key and writable fields are determined here; caller-supplied roles/team/identities are ignored.
    await collection.doc(id).set({ data: { name, avatarFileId, updatedAt: db.serverDate() } });
    return { ok: true, profile: { name, avatarFileId }, avatarPrefix };
  } catch (error) {
    console.error('User profile operation failed:', error.errCode || error.code || 'PROFILE_FAILED');
    return { ok: false, code: 'PROFILE_FAILED', message: '个人资料暂时无法保存或读取，请稍后重试。' };
  }
};
