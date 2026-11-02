let initialized = false, manager = null;
let state = { envVersion: '', version: '', versionLabel: '版本信息暂不可用', status: 'checking' };
const listeners = new Set();
function publish(value) { state = { ...state, ...value }; listeners.forEach(listener => listener({ ...state })); }
function init() {
  if (initialized) return;
  initialized = true;
  try {
    const info = typeof wx.getAccountInfoSync === 'function' && wx.getAccountInfoSync();
    const app = info && info.miniProgram || {};
    const environment = { develop: '开发版', trial: '体验版', release: '正式版' }[app.envVersion] || '';
    publish({ envVersion: app.envVersion || '', version: app.version || '', versionLabel: app.version ? app.version + (environment ? ' · ' + environment : '') : environment || state.versionLabel });
    if (app.envVersion && app.envVersion !== 'release') { publish({ status: 'development' }); return; }
    if (typeof wx.getUpdateManager !== 'function') { publish({ status: 'unsupported' }); return; }
    manager = wx.getUpdateManager();
    if (!manager) { publish({ status: 'unsupported' }); return; }
    manager.onCheckForUpdate(result => {
      if (!result || typeof result.hasUpdate !== 'boolean') { publish({ status: 'failed' }); return; }
      if (!['ready', 'failed'].includes(state.status)) publish({ status: result.hasUpdate ? 'downloading' : 'latest' });
    });
    manager.onUpdateReady(() => publish({ status: 'ready' }));
    manager.onUpdateFailed(() => publish({ status: 'failed' }));
  } catch (_) { publish({ status: 'unsupported' }); }
}
function current() { init(); return { ...state }; }
function subscribe(listener) { init(); listeners.add(listener); listener(current()); return () => listeners.delete(listener); }
function apply() {
  if (!manager || state.status !== 'ready') return false;
  manager.applyUpdate();
  return true;
}
module.exports = { init, current, subscribe, apply };
