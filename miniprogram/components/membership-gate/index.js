const membership = require('../../services/membership');
const profiles = require('../../services/profile');
Component({
  data: { phase: 'checking', error: '', name: '', avatar: '', draftAvatar: '', saving: false, top: 84 },
  lifetimes: {
    attached() {
      this.setData({ top: (wx.getWindowInfo().statusBarHeight || 20) + 64 });
      this._unsubscribe = membership.subscribe(state => {
        if (this._detached) return;
        this.setData({ phase: state.phase, error: state.error || '' });
        if (state.phase === 'apply' && !this._profileRequested) this.loadProfile();
      });
    },
    detached() { this._detached = true; if (this._unsubscribe) this._unsubscribe(); }
  },
  methods: {
    async loadProfile() {
      this._profileRequested = true;
      try {
        const result = await profiles.load(true);
        if (!this._detached && this.data.phase === 'apply' && result.profile) this.setData({ ...(!this._nameEdited ? { name: result.profile.name } : {}), avatar: result.profile.avatarFileId || '' });
      } catch (error) { if (!this._detached) this.setData({ error: error.message }); }
    },
    changeName(event) { if (!this.data.saving) { this._nameEdited = true; this.setData({ name: event.detail.value, error: '' }); } },
    chooseAvatar(event) { if (!this.data.saving) this.setData({ draftAvatar: event.detail.avatarUrl || '' }); },
    avatarFailed() { this.setData({ avatar: '', draftAvatar: '' }); },
    async submitApplication() {
      if (this.data.saving || this.data.phase !== 'apply') return;
      const name = this.data.name.trim();
      if (!name) { this.setData({ error: '请填写姓名' }); return; }
      this.setData({ saving: true, error: '' });
      try { await membership.submit({ name, avatarPath: this.data.draftAvatar }); }
      catch (error) { if (!this._detached) this.setData({ error: error.message || '申请提交失败，请重试。' }); }
      finally { if (!this._detached) this.setData({ saving: false }); }
    },
    checkStatus() { if (!this.data.saving) return membership.check(); }
  }
});
