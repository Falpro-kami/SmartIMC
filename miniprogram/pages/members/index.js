const access = require('../../services/access');
Page(require('../../utils/member-page')({
  data: { loading: true, error: '', members: [], hasMore: false, roleOptions: [], editor: null, saving: false },
  onLoad(options = {}) { this._focusId = options.id || ''; this.loadMembers(); },
  onUnload() { this._unloaded = true; },
  async loadMembers() {
    if (this._loading) return;
    this._loading = true;
    const cached = access.peek && access.peek('list', { offset: 0 });
    if (cached) this.setData({ members: this.present(cached.members), hasMore: cached.hasMore });
    this.setData({ loading: !cached && !this.data.members.length, error: '', editor: null });
    try {
      const current = await access.get();
      if (!access.can(current.member, 'members.manage')) throw new Error('仅超级管理员可以访问成员与权限。');
      const result = await access.list(0);
      if (this._unloaded) return;
      this._offset = result.nextOffset;
      this.setData({ members: this.present(result.members), hasMore: result.hasMore,
        roleOptions: current.roleOptions });
      if (this._focusId) {
        const id = this._focusId;
        this._focusId = '';
        if (!this.data.members.some(member => member.id === id)) {
          const focused = await access.member(id);
          if (this._unloaded) return;
          this.setData({ members: this.present([focused.member]).concat(this.data.members) });
        }
        this.openEditor({ currentTarget: { dataset: { id } } });
      }
    } catch (error) { if (!this._unloaded) this.setData({ error: error.message, members: [], hasMore: false }); }
    finally { this._loading = false; if (!this._unloaded) this.setData({ loading: false }); }
  },
  present(members) {
    return members.map(member => ({ ...member, roleText: member.roleLabels.join('、'),
      statusLabel: { active: '已加入', pending: '待审核', disabled: '已停用' }[member.status] || '-' }));
  },
  async loadMore() {
    if (!this.data.hasMore || this._loading) return;
    this._loading = true;
    try {
      const result = await access.list(this._offset);
      if (this._unloaded) return;
      this._offset = result.nextOffset;
      const existing = new Set(this.data.members.map(member => member.id));
      this.setData({ members: this.data.members.concat(this.present(result.members.filter(member => !existing.has(member.id)))), hasMore: result.hasMore });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally { this._loading = false; }
  },
  openEditor(event) {
    if (this.data.saving) return;
    const member = this.data.members.find(value => value.id === event.currentTarget.dataset.id);
    if (!member) return;
    this.setData({ editor: { ...member, roles: member.roles.slice(),
      options: this.data.roleOptions.map(option => ({ ...option, selected: member.roles.includes(option.value) })) }, formError: '' });
  },
  closeEditor() { if (!this.data.saving) this.setData({ editor: null }); },
  stopTap() {},
  changeRoles(event) {
    const roles = event.detail.value;
    this.setData({ 'editor.roles': roles,
      'editor.options': this.data.editor.options.map(option => ({ ...option, selected: roles.includes(option.value) })) });
  },
  changeStatus(event) { this.setData({ 'editor.status': event.detail.value }); },
  async removeMember() {
    if (this.data.saving || !this.data.editor) return;
    const member = { ...this.data.editor, status: 'removed', roles: [] };
    this.setData({ saving: true, formError: '' });
    try {
      const result = await wx.showModal({ title: '移出成员', content: '确定将“' + member.name + '”移出 IMC？', confirmText: '移出', confirmColor: '#ad4037' });
      if (!result.confirm || this._unloaded) return;
      await access.set(member);
      if (this._unloaded) return;
      wx.showToast({ title: '成员已移出', icon: 'success' });
      await this.loadMembers();
    } catch (error) { if (!this._unloaded) this.setData({ formError: error.message || '移出失败，请重试' }); }
    finally { if (!this._unloaded) this.setData({ saving: false }); }
  },
  async saveMember() {
    if (this.data.saving || !this.data.editor) return;
    this.setData({ saving: true, formError: '' });
    try {
      await access.set(this.data.editor);
      if (this._unloaded) return;
      wx.showToast({ title: '权限已更新', icon: 'success' });
      await this.loadMembers();
    } catch (error) { if (!this._unloaded) this.setData({ formError: error.message }); }
    finally { if (!this._unloaded) this.setData({ saving: false }); }
  }
}));
