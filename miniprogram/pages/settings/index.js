const access = require('../../services/access');
const profiles = require('../../services/profile');
const localCache = require('../../services/local-cache');
const updates = require('../../services/updates');
const TITLES = { main: '设置与帮助', account: '账号信息', privacy: '隐私与授权', storage: '存储管理', help: '使用帮助', feedback: '意见反馈', about: '关于智慧IMC' };
const UPDATE_LABELS = { checking: '正在获取更新状态', latest: '当前已是最新版本', downloading: '有新版本，正在下载', ready: '新版本已就绪', failed: '更新下载失败，请重新进入小程序', development: '开发版与体验版以编译或上传内容为准', unsupported: '当前环境暂不支持版本更新' };
const AUTH_NAMES = { 'scope.camera': '相机', 'scope.record': '麦克风', 'scope.writePhotosAlbum': '保存到相册', 'scope.userLocation': '位置', 'scope.userFuzzyLocation': '大致位置', 'scope.userInfo': '个人信息', 'scope.address': '收货地址', 'scope.invoiceTitle': '发票抬头', 'scope.invoice': '发票', 'scope.bluetooth': '蓝牙', 'scope.addPhoneCalendar': '添加日历' };
const FAQS = [
  { id: 'profile', title: '如何修改姓名和头像？', content: '进入“我的 → 个人资料”，修改后点击保存。姓名和头像会同步到个人页头与团队成员目录。' },
  { id: 'weekly', title: '填写周报后需要保存草稿吗？', content: '周报内容会自动保存草稿。请留意页面的保存状态；填写完成后仍需点击“提交”。提交前可以使用“效果预览”查看阅读效果。' },
  { id: 'files', title: '周报可以上传哪些内容？', content: '按照本期表单要求填写。文本框可插入图片，附件字段可选择文件；文件类型、数量和大小以当前表单提示为准。Word、PDF 文件使用文件上传入口。' },
  { id: 'messages', title: '标记消息已读会完成待办吗？', content: '不会。消息已读只表示你已阅读通知；待办需要完成对应业务才会结束。可以在消息页面使用“全部已读”。' },
  { id: 'roles', title: '为什么我和别人看到的功能不同？', content: '页面和操作会根据团队身份与权限展示。需要调整角色时，请联系团队超级管理员；微信公众平台的开发者权限与 IMC 内部业务角色相互独立。' },
  { id: 'cache', title: '清理缓存会删除周报或备份吗？', content: '只清理可重新下载的本机文件副本和读取缓存。云端周报、草稿、提交记录、头像、偏好设置和加密备份不会被清理。' },
  { id: 'feedback', title: '页面异常或遇到问题怎么办？', content: '先下拉刷新支持刷新的页面，或关闭小程序后重新进入。如仍有问题，可在“意见反馈”中描述操作步骤并附上截图；“关于智慧IMC”可复制版本信息。' }
];
function invoke(name, options = {}) {
  return new Promise((resolve, reject) => {
    if (typeof wx[name] !== 'function') return reject(new Error('当前微信版本暂不支持此操作。'));
    wx[name]({ ...options, success: resolve, fail: reject });
  });
}
function authorizationRows(result) {
  return Object.entries(result && result.authSetting || {}).filter(([key]) => AUTH_NAMES[key]).map(([key, allowed]) => ({ key, label: AUTH_NAMES[key], value: allowed ? '已允许' : '未允许' }));
}
Page(require('../../utils/member-page')({
  data: { view: 'main', versionLabel: '', updateStatus: 'checking', updateLabel: UPDATE_LABELS.checking,
    accountLoading: false, accountError: '', accountFields: [], accountCode: '',
    storageLoading: false, storageError: '', storageSize: '正在读取', storageCount: 0, activeDownloads: 0, clearing: false,
    privacyLoading: false, privacyError: '', privacyContractAvailable: false, authRows: [], faqs: FAQS, openFaq: '', updating: false, exiting: false },
  onLoad(options = {}) {
    const view = Object.prototype.hasOwnProperty.call(TITLES, options.view) ? options.view : 'main';
    this.setData({ view });
    wx.setNavigationBarTitle({ title: TITLES[view] });
  },
  onShow() {
    this._visible = true;
    if (!this._unsubscribeUpdate) this._unsubscribeUpdate = updates.subscribe(value => {
      if (this._visible && !this._unloaded) this.setData({ versionLabel: value.versionLabel, updateStatus: value.status, updateLabel: UPDATE_LABELS[value.status] || UPDATE_LABELS.checking });
    });
    if (this.data.view === 'account') return this.loadAccount();
    if (this.data.view === 'privacy') return this.loadPrivacy();
    if (['main', 'storage'].includes(this.data.view)) return this.loadStorage();
  },
  onHide() { this._visible = false; if (this._unsubscribeUpdate) this._unsubscribeUpdate(); this._unsubscribeUpdate = null; },
  onUnload() { this._unloaded = true; this.onHide(); },
  openView(event) {
    const view = event.currentTarget.dataset.view;
    if (!Object.prototype.hasOwnProperty.call(TITLES, view) || view === 'main' || this._navigating) return;
    this._navigating = true;
    wx.navigateTo({ url: '/pages/settings/index?view=' + view,
      fail() { wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }); }, complete: () => { this._navigating = false; } });
  },
  openProfile() { wx.navigateTo({ url: '/pages/profile/edit' }); },
  async loadAccount() {
    if (this._loadingAccount) return;
    this._loadingAccount = true;
    this.setData({ accountLoading: !this.data.accountFields.length, accountError: '' });
    try {
      const [identity, profile] = await Promise.all([access.get(), profiles.load()]);
      if (this._unloaded) return;
      const member = identity.member, code = identity.accountCode || '';
      this.setData({ accountCode: code, accountFields: [
        { label: '姓名', value: profile.profile && profile.profile.name || '-' },
        { label: '登录方式', value: '微信身份识别' },
        { label: '账号标识', value: code || '-', copy: !!code },
        { label: '成员状态', value: { active: '已加入', pending: '待审核', disabled: '已停用', removed: '已移出' }[member && member.status] || '未加入' },
        { label: '当前角色', value: member && (member.roleLabels || []).join('、') || '普通成员' }
      ] });
    } catch (_) { if (!this._unloaded) this.setData({ accountError: '账号信息读取失败，请重试。' }); }
    finally { this._loadingAccount = false; if (!this._unloaded) this.setData({ accountLoading: false }); }
  },
  copyAccount() { if (this.data.accountCode) invoke('setClipboardData', { data: this.data.accountCode }).catch(() => wx.showToast({ title: '复制失败，请重试', icon: 'none' })); },
  async loadStorage() {
    if (this._loadingStorage) return;
    this._loadingStorage = true;
    this.setData({ storageLoading: true, storageError: '' });
    try {
      const summary = await localCache.snapshot();
      if (!this._unloaded) { this._storageLoaded = true; this.setData({ storageSize: localCache.sizeLabel(summary.bytes), storageCount: summary.count, activeDownloads: summary.activeCount }); }
    } catch (_) { if (!this._unloaded) this.setData({ storageSize: '暂不可用', storageError: '存储信息读取失败，请重试。' }); }
    finally { this._loadingStorage = false; if (!this._unloaded) this.setData({ storageLoading: false }); }
  },
  async clearCache() {
    if (this.data.clearing || this.data.storageLoading || this.data.storageError) return;
    this.setData({ clearing: true });
    try {
      const choice = await invoke('showModal', { title: '清理缓存', content: '将清理本机已下载的文件副本和读取缓存。云端数据、草稿、提交记录、偏好设置和加密备份保留。', confirmText: '清理' });
      if (!choice.confirm || this._unloaded) return;
      const result = await localCache.clear();
      if (!this._unloaded) {
        await this.loadStorage();
        if (result.failed) this.setData({ storageError: '部分文件未能清理，请稍后重试。' });
        else wx.showToast({ title: '缓存已清理', icon: 'success' });
      }
    } catch (_) { if (!this._unloaded) this.setData({ storageError: '缓存清理失败，请稍后重试。' }); }
    finally { if (!this._unloaded) this.setData({ clearing: false }); }
  },
  async loadPrivacy() {
    if (this._loadingPrivacy) return;
    this._loadingPrivacy = true;
    this.setData({ privacyLoading: true, privacyError: '' });
    const [authorization, privacy] = await Promise.allSettled([invoke('getSetting'), invoke('getPrivacySetting')]);
    if (!this._unloaded) this.setData({ privacyLoading: false,
      authRows: authorization.status === 'fulfilled' ? authorizationRows(authorization.value) : [],
      privacyError: authorization.status === 'rejected' ? '授权状态暂时无法读取，可直接管理微信授权。' : '',
      privacyContractAvailable: privacy.status === 'fulfilled' && !!privacy.value.privacyContractName && typeof wx.openPrivacyContract === 'function' });
    this._loadingPrivacy = false;
  },
  openPermissions() {
    invoke('openSetting').then(result => { if (!this._unloaded) this.setData({ authRows: authorizationRows(result), privacyError: '' }); })
      .catch(error => { if (!/cancel/i.test(error.errMsg || '')) wx.showToast({ title: '请在微信小程序菜单中打开设置', icon: 'none' }); });
  },
  openPrivacyContract() { invoke('openPrivacyContract').catch(() => wx.showToast({ title: '隐私保护指引暂时无法打开', icon: 'none' })); },
  toggleFaq(event) { const id = event.currentTarget.dataset.id; this.setData({ openFaq: this.data.openFaq === id ? '' : id }); },
  async copyVersion() {
    const current = updates.current(), lines = ['智慧IMC', '版本：' + current.versionLabel];
    try { const base = wx.getAppBaseInfo(); lines.push('微信：' + base.version, '基础库：' + base.SDKVersion); } catch (_) {}
    try { const device = wx.getDeviceInfo(); lines.push('平台：' + device.platform, '系统：' + device.system); } catch (_) {}
    try { await invoke('setClipboardData', { data: lines.join('\n') }); }
    catch (_) { wx.showToast({ title: '复制失败，请重试', icon: 'none' }); }
  },
  async applyUpdate() {
    if (this.data.updating || this.data.updateStatus !== 'ready') return;
    this.setData({ updating: true });
    try {
      const choice = await invoke('showModal', { title: '重启更新', content: '更新将重新打开小程序，请先确认正在编辑的内容已保存。', confirmText: '重启更新' });
      if (choice.confirm && !this._unloaded && !updates.apply()) wx.showToast({ title: '更新尚未就绪，请稍后重试', icon: 'none' });
    } catch (_) { wx.showToast({ title: '暂时无法更新，请重新进入小程序', icon: 'none' }); }
    finally { if (!this._unloaded) this.setData({ updating: false }); }
  },
  async exitApp() {
    if (this.data.exiting) return;
    this.setData({ exiting: true });
    try {
      const choice = await invoke('showModal', { title: '退出小程序', content: '请确认正在编辑的内容已保存。退出后可从微信重新进入。', confirmText: '退出' });
      if (choice.confirm && !this._unloaded) await invoke('exitMiniProgram');
    } catch (_) { wx.showToast({ title: '请关闭当前小程序窗口退出', icon: 'none' }); }
    finally { if (!this._unloaded) this.setData({ exiting: false }); }
  }
}));
