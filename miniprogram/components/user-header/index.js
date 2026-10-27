const profiles = require('../../services/profile');
const team = require('../../config/team');
const access = require('../../services/access');
const membership = require('../../services/membership');

Component({
  properties: {
    title: { type: String, value: '' }
  },
  data: {
    top: 32, statusBarHeight: 24, navHeight: 44, titleWidth: 120,
    identityWidth: 230, loading: true, error: '', name: '正在识别',
    avatar: '', initials: '人', teamName: team.name,
    drawerOpen: false, roleTags: [], hasUnread: false
  },
  lifetimes: {
    attached() {
      const info = wx.getWindowInfo();
      const menu = wx.getMenuButtonBoundingClientRect();
      const statusBarHeight = info.statusBarHeight || 20;
      const capsuleLeft = menu.left || info.windowWidth - 96;
      const capsuleTop = menu.top || statusBarHeight + 6;
      this.setData({
        top: statusBarHeight + 8, statusBarHeight,
        navHeight: Math.max(44, (capsuleTop - statusBarHeight) * 2 + (menu.height || 32)),
        titleWidth: Math.max(72, (capsuleLeft - info.windowWidth / 2 - 12) * 2),
        identityWidth: Math.max(160, capsuleLeft - 32)
      });
      this._unsubscribe = profiles.subscribe(result => this.renderProfile(result));
      this.loadProfile();
      this.startNotifications();
    },
    detached() { this._detached = true; this.stopNotifications(); if (this._unsubscribe) this._unsubscribe(); }
  },
  pageLifetimes: { show() { this.loadProfile(); this.startNotifications(); }, hide() { this.closeDrawer(); this.stopNotifications(); } },
  methods: {
    startNotifications() {
      const loading = this.loadIdentity();
      if (!this._notificationTimer) this._notificationTimer = setInterval(() => this.loadIdentity(true), 30000);
      return loading;
    },
    stopNotifications() { clearInterval(this._notificationTimer); this._notificationTimer = null; },
    async loadIdentity(force = false) {
      if (this._identityLoading || this._detached) return;
      this._identityLoading = true;
      try {
        const result = await access.get(force);
        if (this._detached) return;
        membership.accept(result);
        const member = result.member;
        let roleTags = [];
        if (member && member.status === 'active') {
          roleTags = (result.roleOptions || []).filter(role => member.roles.includes(role.value));
          if (!roleTags.length) roleTags = [{ value: 'member', label: '普通成员' }];
        } else if (member) roleTags = [{ value: 'inactive', label: { pending: '待审核', disabled: '已停用', removed: '已移出' }[member.status] || '-' }];
        this.setData({ roleTags, hasUnread: result.hasUnread === true });
      } catch (_) { /* Keep the last server-confirmed identity; avoid extra header explanatory text. */ }
      finally { this._identityLoading = false; }
    },
    openMessages() {
      if (this._navigating) return;
      this._navigating = true;
      wx.navigateTo({ url: '/pages/messages/index',
        fail() { wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }); },
        complete: () => { this._navigating = false; } });
    },
    renderProfile(result) {
      if (this._detached) return;
      const profile = result.profile;
      this.setData({ name: profile ? profile.name : '-',
        avatar: profile && profile.avatarFileId || '',
        initials: profile ? Array.from(profile.name).slice(-2).join('') : '人',
        loading: false, error: '' });
    },
    async loadProfile(force = false) {
      if (this._detached) return;
      try { const result = await profiles.load(force); this.renderProfile(result); }
      catch (error) {
        if (!this._detached) this.setData({ loading: false, error: '个人资料读取失败，点击重试', name: '-' });
      }
    },
    openDrawer() { this.setData({ drawerOpen: true }); },
    closeDrawer() { this.setData({ drawerOpen: false }); },
    retryProfile() { this.loadProfile(true); },
    openTeamMembers() {
      if (this._navigating) return;
      this._navigating = true;
      this.closeDrawer();
      wx.navigateTo({ url: '/pages/team-members/index',
        fail() { wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }); },
        complete: () => { this._navigating = false; } });
    },
    avatarFailed() { this.setData({ avatar: '' }); },
    stopTap() {}
  }
});
