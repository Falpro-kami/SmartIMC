const home = require('../../services/home');
Page({
  data: { loading: true, error: '', todos: [], announcements: [], canManage: false },
  onShow() {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 0 });
    return this.loadHome();
  },
  onHide() { this._epoch = (this._epoch || 0) + 1; this.setData({ todos: [], announcements: [], canManage: false }); },
  onUnload() { this._unloaded = true; this._epoch = (this._epoch || 0) + 1; },
  async loadHome() {
    const epoch = this._epoch = (this._epoch || 0) + 1;
    this.setData({ loading: true, error: '', todos: [], announcements: [], canManage: false });
    try {
      const result = await home.dashboard();
      if (this._unloaded || epoch !== this._epoch) return;
      this.setData({ todos: result.todos.map(home.present), announcements: result.announcements.map(home.present), canManage: result.canManage });
    } catch (error) { if (!this._unloaded && epoch === this._epoch) this.setData({ error: error.message }); }
    finally { if (!this._unloaded && epoch === this._epoch) this.setData({ loading: false }); }
  },
  openTodo(event) {
    const todo = this.data.todos.find(item => item.id === event.currentTarget.dataset.id);
    if (todo && /^user_[a-f0-9]{32}$/.test(todo.memberId)) wx.navigateTo({ url: '/pages/members/index?id=' + encodeURIComponent(todo.memberId) });
  },
  openApprovals() { wx.navigateTo({ url: '/pages/approvals/index?scope=pending' }); },
  openAnnouncements() { wx.navigateTo({ url: '/pages/module/index?id=announcements' }); },
  openAnnouncement(event) {
    const item = this.data.announcements.find(row => row.id === event.currentTarget.dataset.id);
    if (item) wx.navigateTo({ url: '/pages/module/index?id=announcements&announcement=' + encodeURIComponent(item.id) });
  },
  publishAnnouncement() { if (this.data.canManage) wx.navigateTo({ url: '/pages/module/index?id=announcements&compose=1' }); }
});
