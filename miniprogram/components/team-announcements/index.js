const home = require('../../services/home');
function newId() { return 'ann_' + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''); }
Component({
  properties: { initialId: { type: String, value: '' }, compose: { type: Boolean, value: false } },
  data: { mode: 'list', loading: true, saving: false, error: '', formError: '', announcements: [], hasMore: false,
    canManage: false, selected: null, draft: null },
  lifetimes: { attached() { this.loadAnnouncements(); }, detached() { this._detached = true; this._epoch = (this._epoch || 0) + 1; } },
  pageLifetimes: { show() { if (this._initialized && !this.data.saving) this.refresh(); } },
  methods: {
    async refresh() {
      if (this.data.mode === 'detail' && this.data.selected) return this.openDetail(this.data.selected.id);
      if (this.data.mode === 'edit') {
        const epoch = this._epoch = (this._epoch || 0) + 1;
        this.setData({ canManage: false });
        try {
          const result = await home.list(0);
          if (this._detached || epoch !== this._epoch) return;
          this.setData({ canManage: result.canManage });
          if (!result.canManage) this.setData({ mode: 'list', draft: null, announcements: result.announcements.map(home.present) });
        } catch (error) { if (!this._detached && epoch === this._epoch) this.setData({ mode: 'list', draft: null, selected: null, announcements: [], canManage: false, error: error.message }); }
        return;
      }
      return this.loadAnnouncements();
    },
    async loadAnnouncements() {
      if (this.data.saving) return;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, error: '', mode: 'list', announcements: [], selected: null, canManage: false, hasMore: false });
      try {
        const result = await home.list(0);
        if (this._detached || epoch !== this._epoch) return;
        this._offset = result.nextOffset;
        this.setData({ announcements: result.announcements.map(home.present), canManage: result.canManage, hasMore: result.hasMore });
        if (!this._initialized) {
          this._initialized = true;
          if (this.properties.initialId) { await this.openDetail(this.properties.initialId); return; }
          if (this.properties.compose && result.canManage) this.newAnnouncement();
        }
      } catch (error) { if (!this._detached && epoch === this._epoch) this.setData({ error: error.message }); }
      finally { if (!this._detached && epoch === this._epoch) this.setData({ loading: false }); }
    },
    async loadMore() {
      if (this.data.loading || !this.data.hasMore) return;
      const epoch = this._epoch;
      this.setData({ loading: true });
      try {
        const result = await home.list(this._offset);
        if (this._detached || epoch !== this._epoch) return;
        if (result.nextOffset !== this._offset + result.announcements.length || (result.hasMore && result.nextOffset <= this._offset)) throw new Error('公告读取失败，请重试。');
        this._offset = result.nextOffset;
        const ids = new Set(this.data.announcements.map(item => item.id));
        this.setData({ announcements: this.data.announcements.concat(result.announcements.filter(item => !ids.has(item.id)).map(home.present)), canManage: result.canManage, hasMore: result.hasMore });
      } catch (error) {
        if (!this._detached && epoch === this._epoch) {
          this.setData({ announcements: [], canManage: false, error: error.message });
        }
      } finally { if (!this._detached && epoch === this._epoch) this.setData({ loading: false }); }
    },
    selectAnnouncement(event) { return this.openDetail(event.currentTarget.dataset.id); },
    async openDetail(id) {
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ mode: 'detail', loading: true, selected: null, error: '', canManage: false });
      try {
        const result = await home.get(id);
        if (!this._detached && epoch === this._epoch) this.setData({ selected: home.present(result.announcement), canManage: result.canManage });
      } catch (error) { if (!this._detached && epoch === this._epoch) this.setData({ error: error.message }); }
      finally { if (!this._detached && epoch === this._epoch) this.setData({ loading: false }); }
    },
    newAnnouncement() {
      if (!this.data.canManage || this.data.saving) return;
      this.setData({ mode: 'edit', draft: { id: newId(), revision: 0, title: '', body: '', pinned: false }, formError: '', error: '' });
    },
    editAnnouncement() {
      if (!this.data.canManage || !this.data.selected || this.data.saving) return;
      this.setData({ mode: 'edit', draft: { ...this.data.selected }, formError: '', error: '' });
    },
    onTitle(event) { this.setData({ 'draft.title': event.detail.value }); },
    onBody(event) { this.setData({ 'draft.body': event.detail.value }); },
    onPinned(event) { this.setData({ 'draft.pinned': event.detail.value }); },
    async saveAnnouncement() {
      if (!this.data.canManage || !this.data.draft || this.data.saving) return;
      const item = this.data.draft;
      if (!item.title.trim() || item.title.trim().length > 80 || !item.body.trim() || item.body.trim().length > 10000) {
        this.setData({ formError: '标题需1至80字，正文需1至10000字。' }); return;
      }
      this.setData({ saving: true, formError: '' });
      try {
        await home.save({ id: item.id, revision: item.revision, title: item.title, body: item.body, pinned: item.pinned });
        if (this._detached) return;
        wx.showToast({ title: item.revision ? '公告已更新' : '公告已发布', icon: 'success' });
        this.setData({ draft: null });
        await this.openDetail(item.id);
      } catch (error) { if (!this._detached) this.setData({ formError: error.message }); }
      finally { if (!this._detached) this.setData({ saving: false }); }
    },
    async withdrawAnnouncement() {
      if (!this.data.canManage || !this.data.selected || this.data.saving) return;
      this.setData({ saving: true });
      try {
        const result = await wx.showModal({ title: '撤下公告', content: '确定撤下这条公告？', confirmText: '撤下', confirmColor: '#ad4037' });
        if (!result.confirm || this._detached) return;
        await home.withdraw(this.data.selected);
        if (this._detached) return;
        wx.showToast({ title: '公告已撤下', icon: 'success' });
        this.setData({ saving: false });
        await this.loadAnnouncements();
      } catch (error) { if (!this._detached) wx.showToast({ title: error.message, icon: 'none' }); }
      finally { if (!this._detached) this.setData({ saving: false }); }
    },
    async backToList() {
      if (this.data.saving) return;
      if (this.data.mode === 'edit') {
        const result = await wx.showModal({ title: '放弃编辑', content: '确定放弃本次编辑？', confirmText: '放弃' });
        if (!result.confirm || this._detached) return;
      }
      this.setData({ draft: null });
      return this.loadAnnouncements();
    }
  }
});
