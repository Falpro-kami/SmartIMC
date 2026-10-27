const access = require('../../services/access');
const adminData = require('../../services/admin-data');
const PERSONAL_ENTRIES = [
  { id: 'my-equipment', title: '我的设备' },
  { id: 'my-submissions', title: '我的提交' },
  { id: 'my-favorites', title: '我的收藏' }
];
Page({
  data: { loading: true, error: '', status: '', statusLabel: '', roleText: '', canManage: false, applying: false,
    personalEntries: PERSONAL_ENTRIES, expiryLabel: '-', expiryWarning: false },
  onShow() {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 2 });
    this.loadAccess();
  },
  onUnload() { this._unloaded = true; },
  async loadAccess() {
    const epoch = this._accessEpoch = (this._accessEpoch || 0) + 1;
    this.setData({ loading: true, error: '', canManage: false, expiryLabel: '-', expiryWarning: false });
    try {
      const result = await access.get();
      if (this._unloaded || epoch !== this._accessEpoch) return;
      const member = result.member;
      const status = member ? member.status : 'not_joined';
      this.setData({ status,
        statusLabel: { active: '已加入', pending: '待审核', disabled: '已停用', not_joined: '未加入' }[status] || '-',
        roleText: member && member.status === 'active' ? member.roleLabels.join('、') : '-',
        canManage: access.can(member, 'members.manage') });
      if (this.data.canManage) this.loadAdminStatus(epoch);
    } catch (error) { if (!this._unloaded && epoch === this._accessEpoch) this.setData({ error: error.message }); }
    finally { if (!this._unloaded && epoch === this._accessEpoch) this.setData({ loading: false }); }
  },
  async applyJoin() {
    if (this.data.applying) return;
    this.setData({ applying: true, error: '' });
    try { await access.apply(); await this.loadAccess(); }
    catch (error) { if (!this._unloaded) this.setData({ error: error.message }); }
    finally { if (!this._unloaded) this.setData({ applying: false }); }
  },
  openMembers() {
    if (this.data.canManage) wx.navigateTo({ url: '/pages/members/index' });
  },
  openProfile() {
    wx.navigateTo({ url: '/pages/profile/edit' });
  },
  openPersonal(event) {
    const entry = PERSONAL_ENTRIES.find(item => item.id === event.currentTarget.dataset.id);
    if (entry) wx.navigateTo({ url: '/pages/module/index?id=' + entry.id });
  },
  openTeamMembers() {
    wx.navigateTo({ url: '/pages/team-members/index' });
  },
  openSettings() {
    wx.navigateTo({ url: '/pages/module/index?id=settings' });
  },
  async loadAdminStatus(epoch) {
    try {
      const result = await adminData.status();
      if (this._unloaded || epoch !== this._accessEpoch || !this.data.canManage) return;
      this.setData({ expiryLabel: adminData.expiryLabel(result.billing), expiryWarning: result.billing.daysRemaining !== null && result.billing.daysRemaining <= 14 });
    } catch (_) { /* The detailed page provides retry without blocking personal information. */ }
  },
  openDataBackup() {
    if (this.data.canManage) wx.navigateTo({ url: '/pages/module/index?id=data-backup' });
  },
  openServiceExpiry() {
    if (this.data.canManage) wx.navigateTo({ url: '/pages/module/index?id=service-expiry' });
  }
});
