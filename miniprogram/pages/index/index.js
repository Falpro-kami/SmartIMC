const home = require('../../services/home');
Page(require('../../utils/member-page')({
  data: { loading: true, error: '', todos: [], allTodos: [], expandedTodos: false, announcements: [], canManage: false },
  onShow() {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 0 });
    return this.loadHome();
  },
  onHide() { this._epoch = (this._epoch || 0) + 1; this.setData({ todos: [], allTodos: [], announcements: [], canManage: false }); },
  onUnload() { this._unloaded = true; this._epoch = (this._epoch || 0) + 1; },
  async loadHome() {
    const epoch = this._epoch = (this._epoch || 0) + 1;
    this.setData({ loading: true, error: '', todos: [], allTodos: [], announcements: [], canManage: false });
    try {
      const result = await home.dashboard();
      if (this._unloaded || epoch !== this._epoch) return;
      const allTodos = result.todos.map(home.present);
      this.setData({ allTodos, todos: this.data.expandedTodos ? allTodos : allTodos.slice(0, 5), announcements: result.announcements.map(home.present), canManage: result.canManage });
    } catch (error) { if (!this._unloaded && epoch === this._epoch) this.setData({ error: error.message }); }
    finally { if (!this._unloaded && epoch === this._epoch) this.setData({ loading: false }); }
  },
  openTodo(event) {
    const todo = this.data.todos.find(item => item.id === event.currentTarget.dataset.id);
    if (todo && /^user_[a-f0-9]{32}$/.test(todo.memberId)) wx.navigateTo({ url: '/pages/members/index?id=' + encodeURIComponent(todo.memberId) });
    else if (todo && /^wp_[a-f0-9]{32}$/.test(todo.periodId)) wx.navigateTo({ url: '/pages/module/index?id=weekly&period=' + todo.periodId });
  },
  toggleTodos() { const expandedTodos = !this.data.expandedTodos; this.setData({ expandedTodos, todos: expandedTodos ? this.data.allTodos : this.data.allTodos.slice(0, 5) }); },
  openApprovals() { wx.navigateTo({ url: '/pages/approvals/index?scope=pending' }); },
  openAnnouncements() { wx.navigateTo({ url: '/pages/module/index?id=announcements' }); },
  openAnnouncement(event) {
    const item = this.data.announcements.find(row => row.id === event.currentTarget.dataset.id);
    if (item) wx.navigateTo({ url: '/pages/module/index?id=announcements&announcement=' + encodeURIComponent(item.id) });
  },
  publishAnnouncement() { if (this.data.canManage) wx.navigateTo({ url: '/pages/module/index?id=announcements&compose=1' }); }
}));
