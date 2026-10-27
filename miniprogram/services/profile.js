const cloudConfig = require('../config/cloud');
let state = null;
let pending = null;
let saving = false;
const subscribers = new Set();

function publish(next) {
  state = next;
  subscribers.forEach(listener => listener(next));
  return next;
}

async function call(data) {
  if (!getApp().globalData.cloudReady) throw new Error('云开发尚未准备好，请重新打开小程序。');
  const response = await wx.cloud.callFunction({ name: cloudConfig.profileFunction, data });
  const result = response.result;
  if (!result || !result.ok) {
    const error = new Error(result && result.message || '个人资料服务返回异常，请重试。');
    // Only validation rejection proves that the server did not commit this avatar.
    error.safeToRemoveUpload = !!(result && ['INVALID_NAME', 'INVALID_AVATAR', 'AUTH_REQUIRED', 'INVALID_ACTION'].includes(result.code));
    throw error;
  }
  return result;
}

function load(force = false) {
  if (pending) return pending;
  if (!force && state) return Promise.resolve(state);
  pending = call({ action: 'get' }).then(publish).finally(() => { pending = null; });
  return pending;
}

async function save({ name, avatarPath = '' }) {
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed.length > 32) throw new Error('请填写姓名，最多32个字。');
  if (saving) throw new Error('资料正在保存，请稍候。');
  saving = true;
  let uploaded = '';
  let committed = false;
  let safeToRemoveUpload = false;
  try {
    const current = await load();
    let avatarFileId = current.profile && current.profile.avatarFileId || '';
    if (avatarPath) {
      const suffix = /\.(png|jpeg|jpg)(?:\?.*)?$/i.exec(avatarPath);
      const extension = suffix ? suffix[1].toLowerCase() : 'jpg';
      const cloudPath = current.avatarPrefix + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.' + extension;
      const upload = await wx.cloud.uploadFile({ cloudPath, filePath: avatarPath });
      if (!upload.fileID) throw new Error('头像上传失败，请重试。');
      avatarFileId = uploaded = upload.fileID;
    }
    const result = await call({ action: 'save', name: trimmed, avatarFileId });
    committed = true;
    publish(result);
    return result;
  } catch (error) {
    safeToRemoveUpload = error.safeToRemoveUpload === true;
    throw error;
  } finally {
    // A timeout may hide a successful save. Keep that file until the outcome is known.
    if (uploaded && !committed && safeToRemoveUpload) {
      try { await wx.cloud.deleteFile({ fileList: [uploaded] }); } catch (_) { /* Keep the original save error. */ }
    }
    saving = false;
  }
}

function subscribe(listener) {
  subscribers.add(listener);
  if (state) listener(state);
  return () => subscribers.delete(listener);
}

module.exports = { load, save, subscribe };
