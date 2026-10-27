const adminData = require('../../services/admin-data');
const MODULES = {
  finance: { title: '财务报销', icon: 'finance', description: '报销申请与办理记录将在这里展示' },
  weekly: { title: '周报', icon: 'weekly', description: '团队周报与提交记录将在这里展示' },
  activities: { title: '文娱活动', icon: 'activities', description: '实验室活动与报名信息将在这里展示' },
  'ai-challenge': { title: 'AI挑战赛', icon: 'ai-challenge', description: '挑战赛题目与参赛信息将在这里展示' },
  leave: { title: '请假', icon: 'leave' },
  knowledge: { title: '团队知识库', icon: 'knowledge' },
  'weekly-sharing': { title: '每周分享', icon: 'weekly-sharing' },
  'my-equipment': { title: '我的设备' },
  'my-submissions': { title: '我的提交' },
  'my-favorites': { title: '我的收藏' },
  privacy: { title: '隐私与授权' },
  feedback: { title: '意见反馈' },
  'account-data': { title: '账号与数据' },
  about: { title: '关于智慧IMC' },
  'data-backup': { title: '数据备份', adminMode: 'backup' },
  'service-expiry': { title: '到期提醒', adminMode: 'expiry' },
  settings: {
    title: '设置与帮助',
    entries: [
      { id: 'privacy', title: '隐私与授权' },
      { id: 'feedback', title: '意见反馈' },
      { id: 'account-data', title: '账号与数据' },
      { id: 'about', title: '关于智慧IMC' }
    ]
  }
};
Page({
  data: { title: '', icon: '', description: '', entries: [], adminMode: '', adminLoading: false, adminError: '',
    billing: null, expiryLabel: '-', expiryWarning: false, backups: [], password: '', passwordConfirm: '', creating: false, downloading: '', progress: 0, exportedId: '' },
  onLoad(options) {
    const module = Object.prototype.hasOwnProperty.call(MODULES, options.id) ? MODULES[options.id] : null;
    if (!module) { this.setData({ title: '页面不存在', description: '请返回工作台选择功能' }); return; }
    this.setData(module);
    wx.setNavigationBarTitle({ title: module.title });
    if (module.adminMode) this.loadAdminData();
  },
  onUnload() { this._unloaded = true; this._downloads = {}; },
  onShow() { if (this.data.adminMode && !this.data.creating && !this.data.downloading) return this.loadAdminData(); },
  openEntry(event) {
    const entry = this.data.entries.find(item => item.id === event.currentTarget.dataset.id);
    if (entry) wx.navigateTo({ url: '/pages/module/index?id=' + entry.id });
  },
  async loadAdminData() {
    if (!this.data.adminMode || this.data.adminLoading) return;
    this.setData({ adminLoading: true, adminError: '', billing: null, backups: [] });
    try {
      const result = await adminData.status();
      if (this._unloaded) return;
      this.setData({ billing: result.billing, expiryLabel: adminData.expiryLabel(result.billing),
        expiryWarning: result.billing.daysRemaining !== null && result.billing.daysRemaining <= 14,
        backups: result.backups.map(adminData.present) });
    } catch (error) { if (!this._unloaded) this.setData({ adminError: error.message }); }
    finally { if (!this._unloaded) this.setData({ adminLoading: false }); }
  },
  onBackupPassword(event) { this.setData({ password: event.detail.value }); },
  onBackupPasswordConfirm(event) { this.setData({ passwordConfirm: event.detail.value }); },
  async createBackup() {
    if (this.data.creating || this.data.downloading || !this.data.billing) return;
    const password = this.data.password;
    if (password.length < 12 || password.length > 128) { wx.showToast({ title: '密码需12至128个字符', icon: 'none' }); return; }
    if (password !== this.data.passwordConfirm) { wx.showToast({ title: '两次输入的密码不一致', icon: 'none' }); return; }
    this.setData({ creating: true, password: '', passwordConfirm: '', adminError: '' });
    try {
      const result = await adminData.create(password);
      if (this._unloaded) return;
      this.setData({ backups: [adminData.present(result.backup)].concat(this.data.backups).slice(0, 10) });
      wx.showToast({ title: '备份已创建', icon: 'success' });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally { if (!this._unloaded) this.setData({ creating: false }); }
  },
  async downloadBackup(event) {
    if (this.data.downloading || this.data.creating) return;
    const record = this.data.backups.find(item => item.id === event.currentTarget.dataset.id);
    if (!record) return;
    this.setData({ downloading: record.id, progress: 0 });
    try {
      const file = await adminData.download(record, progress => { if (!this._unloaded) this.setData({ progress }); });
      if (this._unloaded) return;
      this._downloads = this._downloads || {};
      this._downloads[record.id] = file;
      this.setData({ exportedId: record.id });
      wx.showToast({ title: '备份已下载', icon: 'success' });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message || '下载失败，请重试', icon: 'none' }); }
    finally { if (!this._unloaded) this.setData({ downloading: '' }); }
  },
  exportBackup(event) {
    const file = this._downloads && this._downloads[event.currentTarget.dataset.id];
    if (!file) return;
    if (typeof wx.shareFileMessage === 'function') {
      wx.shareFileMessage({ ...file, fail: error => { if (!/cancel/i.test(error.errMsg || '')) wx.showToast({ title: '导出失败，请重试', icon: 'none' }); } });
    } else if (typeof wx.saveFileToDisk === 'function') {
      wx.saveFileToDisk({ filePath: file.filePath, fail: () => wx.showToast({ title: '保存失败，请重试', icon: 'none' }) });
    } else wx.showToast({ title: '请在新版手机微信中导出', icon: 'none' });
  }
});
