const profiles = require('../../services/profile');
const team = require('../../config/team');
Page(require('../../utils/member-page')({
  data: { loading: true, error: '', name: '', avatar: '', draftAvatar: '', initials: '人', teamName: team.name, saving: false },
  onLoad() { this.loadProfile(); },
  onUnload() { this._unloaded = true; },
  async loadProfile() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await profiles.load(true);
      if (this._unloaded) return;
      const profile = result.profile;
      this.setData({ name: profile ? profile.name : '', avatar: profile && profile.avatarFileId || '',
        initials: profile ? Array.from(profile.name).slice(-2).join('') : '人' });
    } catch (error) { if (!this._unloaded) this.setData({ error: error.message || '个人资料读取失败，请重试' }); }
    finally { if (!this._unloaded) this.setData({ loading: false }); }
  },
  onNameInput(event) { this.setData({ name: event.detail.value, error: '' }); },
  onChooseAvatar(event) {
    if (!this.data.saving && event.detail.avatarUrl) this.setData({ draftAvatar: event.detail.avatarUrl, error: '' });
  },
  avatarFailed() { this.setData({ avatar: '', draftAvatar: '' }); },
  async saveProfile() {
    if (this.data.saving || this.data.loading) return;
    const name = this.data.name.trim();
    if (!name) { this.setData({ error: '请先填写姓名' }); return; }
    this.setData({ saving: true, error: '' });
    try {
      const result = await profiles.save({ name, avatarPath: this.data.draftAvatar });
      if (this._unloaded) return;
      this.setData({ name: result.profile.name, avatar: result.profile.avatarFileId || '', draftAvatar: '',
        initials: Array.from(result.profile.name).slice(-2).join('') });
      wx.showToast({ title: '资料已保存', icon: 'success' });
    } catch (error) { if (!this._unloaded) this.setData({ error: error.message || '保存失败，请重试' }); }
    finally { if (!this._unloaded) this.setData({ saving: false }); }
  }
}));
