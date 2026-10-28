const adminData = require('../../services/admin-data');
const MODULES = {
  announcements: { title: '团队公告', announcementsMode: true },
  finance: { title: '财务报销', icon: 'finance', description: '报销申请与办理记录将在这里展示' },
  weekly: { title: '周报', weeklyMode: true },
  activities: { title: '文娱活动', icon: 'activities', description: '实验室活动与报名信息将在这里展示' },
  'ai-challenge': { title: 'AI挑战赛', icon: 'ai-challenge', description: '挑战赛题目与参赛信息将在这里展示' },
  leave: { title: '请假', icon: 'leave' },
  knowledge: { title: '团队知识库', icon: 'knowledge' },
  'weekly-sharing': { title: '每周分享', icon: 'weekly-sharing' },
  'my-equipment': { title: '我的设备', uiIcon: 'monitor' },
  'my-submissions': { title: '我的提交', uiIcon: 'file' },
  'my-favorites': { title: '我的收藏', uiIcon: 'star' },
  privacy: { title: '隐私与授权', uiIcon: 'lock' },
  feedback: { title: '意见反馈', uiIcon: 'chat' },
  'account-data': { title: '账号与数据', uiIcon: 'shield' },
  about: { title: '关于智慧IMC', uiIcon: 'info' },
  'data-backup': { title: '数据备份', adminMode: 'backup' },
  'service-expiry': { title: '到期提醒', adminMode: 'expiry' },
  settings: {
    title: '设置与帮助',
    entries: [
      { id: 'privacy', title: '隐私与授权', icon: 'lock' },
      { id: 'feedback', title: '意见反馈', icon: 'chat' },
      { id: 'account-data', title: '账号与数据', icon: 'shield' },
      { id: 'about', title: '关于智慧IMC', icon: 'info' }
    ]
  }
};
Page(require('../../utils/member-page')({
  data: { title: '', icon: '', uiIcon: 'folder', description: '', entries: [], weeklyMode: false, weeklyPeriod: '', weeklyView: 'detail', weeklyOwner: '', weeklyTemplate: '', weeklyChooseTemplate: false, announcementsMode: false, announcementId: '', composeAnnouncement: false, adminMode: '', adminLoading: false, adminError: '',
    billing: null, expiryLabel: '-', expiryWarning: false, backups: [], password: '', passwordConfirm: '', creating: false, downloading: '', progress: 0, exportedId: '' },
  onLoad(options) {
    const module = Object.prototype.hasOwnProperty.call(MODULES, options.id) ? MODULES[options.id] : null;
    if (!module) { this.setData({ title: '页面不存在', description: '请返回工作台选择功能' }); return; }
    const weeklyView = ['publish', 'templates', 'template-edit', 'template-preview', 'period-form'].includes(options.view) ? options.view : /^wp_[a-f0-9]{32}$/.test(options.period || '') && ['team', 'settings', 'submission-preview'].includes(options.view) ? options.view : 'detail';
    const weeklyPeriod = !['publish', 'templates', 'template-edit', 'template-preview', 'period-form'].includes(weeklyView) && /^wp_[a-f0-9]{32}$/.test(options.period || '') ? options.period : '';
    const weeklyOwner = weeklyPeriod && weeklyView === 'detail' && /^user_[a-f0-9]{32}$/.test(options.owner || '') ? options.owner : '';
    const weeklyTemplate = weeklyView === 'template-edit' && /^wt_[a-f0-9]{32}$/.test(options.template || '') ? options.template : weeklyView === 'template-edit' ? 'new' : '';
    const weeklyChooseTemplate = weeklyView === 'templates' && options.choose === '1';
    this.setData({ ...module, ...(module.weeklyMode ? { weeklyPeriod, weeklyView, weeklyOwner, weeklyTemplate, weeklyChooseTemplate } : {}), ...(module.announcementsMode ? {
      announcementId: /^ann_[a-f0-9]{32}$/.test(options.announcement || '') ? options.announcement : '', composeAnnouncement: options.compose === '1'
    } : {}) });
    const weeklyTitle = { publish: '发布周报', settings: '周期设置', templates: '表单模板', 'template-edit': weeklyTemplate === 'new' ? '新建模板' : '编辑模板', 'template-preview': '周报预览', 'submission-preview': '周报预览', 'period-form': '编辑本期表单' }[weeklyView];
    wx.setNavigationBarTitle({ title: module.weeklyMode ? weeklyTitle || (weeklyPeriod ? weeklyView === 'team' ? '团队提交' : weeklyOwner ? '成员周报' : '周报详情' : module.title) : module.title });
    if (module.adminMode) this.loadAdminData();
  },
  onUnload() { this._unloaded = true; this._downloads = {}; },
  onShow() { if (this.data.adminMode && !this.data.creating && !this.data.downloading) return this.loadAdminData(); },
  async onPullDownRefresh() { try {
    const weekly = this.data.weeklyMode && this.selectComponent('#weekly-panel');
    if (weekly) await weekly.refresh(true);
    else if (this.data.adminMode) await this.loadAdminData(true);
  } finally { wx.stopPullDownRefresh(); } },
  openEntry(event) {
    const entry = this.data.entries.find(item => item.id === event.currentTarget.dataset.id);
    if (entry) wx.navigateTo({ url: '/pages/module/index?id=' + entry.id });
  },
  async loadAdminData(force = false) {
    if (!this.data.adminMode || this.data.adminLoading) return;
    const cached = adminData.peek && adminData.peek();
    if (cached) this.renderAdmin(cached);
    this.setData({ adminLoading: !cached && !this.data.billing, adminError: '' });
    try {
      const result = await adminData.status(force === true);
      if (this._unloaded) return;
      this.renderAdmin(result);
    } catch (error) { if (!this._unloaded) this.setData({ adminError: error.message }); }
    finally { if (!this._unloaded) this.setData({ adminLoading: false }); }
  },
  renderAdmin(result) { this.setData({ billing: result.billing, expiryLabel: adminData.expiryLabel(result.billing),
    expiryWarning: result.billing.daysRemaining !== null && result.billing.daysRemaining <= 14, backups: result.backups.map(adminData.present) }); },
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
}));
