const access = require('../../services/access');
Page(require('../../utils/member-page')({
  data: { loading: true, error: '', members: [], hasMore: false },
  onLoad() {
    if (typeof wx.showShareMenu === 'function') wx.showShareMenu({ menus: ['shareAppMessage'] });
  },
  onShow() { return this.loadMembers(); },
  onUnload() { this._unloaded = true; },
  onShareAppMessage() {
    return { title: '邀请你加入 IMC', path: '/pages/profile/index' };
  },
  async loadMembers(force = false) {
    if (this._loading) return;
    this._loading = true;
    const cached = access.peek && access.peek('directory', { offset: 0 });
    if (cached) { this._offset = cached.nextOffset; this.setData({ members: this.present(cached.members), hasMore: cached.hasMore }); }
    this.setData({ loading: !cached && !this._loaded, error: '' });
    try {
      const result = await access.directory(0, force === true);
      if (this._unloaded) return;
      this._offset = result.nextOffset;
      this._loaded = true;
      this.setData({ members: this.present(result.members), hasMore: result.hasMore });
    } catch (error) { if (!this._unloaded) this.setData({ error: error.message, members: [], hasMore: false }); }
    finally { this._loading = false; if (!this._unloaded) this.setData({ loading: false }); }
  },
  present(members) {
    return members.map(member => ({ ...member, initials: Array.from(member.name).slice(-2).join(''), roleText: member.roleLabels.join('、') }));
  },
  onReachBottom() { this.loadMore(); },
  async loadMore() {
    if (this._loading || !this.data.hasMore) return;
    this._loading = true;
    try {
      const result = await access.directory(this._offset);
      if (this._unloaded) return;
      this._offset = result.nextOffset;
      const existing = new Set(this.data.members.map(member => member.id));
      this.setData({ members: this.data.members.concat(this.present(result.members.filter(member => !existing.has(member.id)))), hasMore: result.hasMore });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally { this._loading = false; }
  },
  avatarFailed(event) {
    const index = this.data.members.findIndex(member => member.id === event.currentTarget.dataset.id);
    if (index >= 0) this.setData({ ['members[' + index + '].avatarUrl']: '' });
  }
}));
