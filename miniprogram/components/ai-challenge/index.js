const challenge = require('../../services/challenge');
const localInput = value => challenge.dateLabel(value).split(' ');
const nowInput = () => localInput(Date.now());
Component({
  properties: { initialEvent: { type: String, value: '' } },
  data: { mode: 'list', tab: 'overview', filter: 'all', events: [], selected: null, myTeam: null, teams: [],
    canManage: false, loading: true, busy: false, error: '', actionError: '', hasMore: false, teamsMore: false,
    form: null, members: [], memberIds: [], groupName: '', leaderName: '', registerEdit: false, scoreFile: null, scorePreview: null,
    draftWork: null, coverPath: '', teacher: null, teacherIndex: -1, teacherChoices: [], downloadId: '', progress: 0,
    filters: [{ id: 'all', label: '全部赛事' }, { id: 'open', label: '进行中' }, { id: 'upcoming', label: '未开始' }, { id: 'closed', label: '已截止' }] },
  lifetimes: {
    attached() { this._visible = true; this._eventId = this.properties.initialEvent; this.startLive(); this.load(); },
    detached() { this._detached = true; this._epoch = (this._epoch || 0) + 1; clearTimeout(this._boundaryTimer); this.stopLive(); this.clearFiles(); }
  },
  pageLifetimes: {
    show() { this._visible = true; const changed = this.startLive(); if (!changed && this._initialized && !this.data.busy && !this.data.downloadId && !['editor', 'teacher'].includes(this.data.mode)) this.load(); },
    hide() { this._visible = false; this._epoch = (this._epoch || 0) + 1; clearTimeout(this._boundaryTimer); this.stopLive(); this.clearFiles(); this.setData({ coverPath: '' }); }
  },
  methods: {
    startLive() {
      const scope = challenge.identityScope(), changed = this._identityScope !== undefined && scope !== this._identityScope;
      if (this._identityScope === undefined) this._identityScope = scope;
      else if (changed) this.memberChanged();
      if (!this._unsubscribe) this._unsubscribe = challenge.subscribe(() => {
        if (!this._visible || this.data.busy || this.data.downloadId || ['editor', 'teacher'].includes(this.data.mode)) return;
        this.setData({ teams: [], myTeam: null }); this.clearFiles();
        this.load();
      });
      if (!this._unsubscribeMembers) this._unsubscribeMembers = challenge.subscribeMembers(() => this.memberChanged());
      return changed;
    },
    sameIdentity(scope) { return !this._detached && scope === challenge.identityScope(); },
    memberChanged() {
      const scope = challenge.identityScope();
      // Reconnecting after the native picker republishes members even when the
      // current account and its permissions have not changed.
      if (scope === this._identityScope) { if (this._visible) return this.refresh(); return; }
      this._identityScope = scope; this._epoch = (this._epoch || 0) + 1;
      this._requestId = ''; this._coverKey = ''; this._dirty = false;
      this.setData({ selected: null, myTeam: null, teams: [], events: [], members: [], form: null, mode: 'list',
        canManage: false, teacher: null, draftWork: null, scoreFile: null, scorePreview: null, coverPath: '', groupName: '', memberIds: [] });
      this.clearFiles(); if (this._visible) return this.load();
    },
    stopLive() { if (this._unsubscribe) this._unsubscribe(); if (this._unsubscribeMembers) this._unsubscribeMembers(); this._unsubscribe = this._unsubscribeMembers = null; },
    async clearFiles() { const files = this._files || []; this._files = []; for (const file of files) await challenge.removeLocal(file); },
    async refresh() { if (!this.data.busy && !this.data.downloadId && !['editor', 'teacher'].includes(this.data.mode)) return this.load(); },
    async load(more = false) {
      more = more === true; const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, error: '', actionError: '' });
      try {
        if (this._eventId) {
          const result = await challenge.call('get', { eventId: this._eventId });
          if (this._detached || epoch !== this._epoch) return;
          this.render(result);
          if (this.data.selected.canReview && ['teams', 'works'].includes(this.data.tab)) await this.loadTeams(false);
        } else {
          const result = await challenge.call('list', { offset: more ? this._offset || 0 : 0 });
          if (this._detached || epoch !== this._epoch) return;
          this._offset = result.nextOffset; this._allEvents = (more ? this._allEvents || [] : []).concat(result.events.map(challenge.eventView));
          this.setData({ mode: 'list', events: this._allEvents.filter(row => this.data.filter === 'all' || row.phase === this.data.filter), canManage: result.canManage,
            teacher: result.teacher || null, hasMore: result.hasMore });
        }
        this._initialized = true;
      } catch (error) { if (!this._detached && epoch === this._epoch) { this._dirty = false; this._coverKey = ''; this.clearFiles(); this.setData({ error: error.message, selected: null, myTeam: null, teams: [], events: [], canManage: false, draftWork: null, coverPath: '', scorePreview: null }); } }
      finally { if (!this._detached && epoch === this._epoch) this.setData({ loading: false }); }
    },
    render(result) {
      const selected = challenge.eventView(result.event), myTeam = result.myTeam ? challenge.teamView(result.myTeam) : null;
      if (!myTeam?.canUpload) { this._requestId = ''; this.setData({ draftWork: null }); }
      const preserve = this._dirty && (myTeam?.canEdit || !myTeam && selected.canRegister);
      this.setData({ mode: 'detail', selected, myTeam, canManage: selected.canManage, teacher: result.teacher || null,
        ...(!preserve ? { groupName: myTeam?.name || '', memberIds: myTeam?.memberIds || [], registerEdit: false } : {}) });
      this.loadCover(selected);
      this.armBoundary(selected);
    },
    armBoundary(selected) {
      clearTimeout(this._boundaryTimer);
      const next = [selected.startMs, selected.endMs].filter(ms => ms > Date.now()).sort((a, b) => a - b)[0];
      if (!next || this._detached || !this._visible) return;
      const update = () => { if (this._detached || !this._visible) return; if (this.data.busy) this._boundaryTimer = setTimeout(update, 1000); else this.load(); };
      this._boundaryTimer = setTimeout(update, Math.min(next - Date.now() + 50, 2147480000));
    },
    async loadCover(selected) {
      const key = selected.id + ':' + selected.cover.id;
      if (this._coverKey === key && this.data.coverPath) return;
      this._coverKey = key; this.setData({ coverPath: '' });
      try {
        const path = await challenge.download(selected.id, selected.cover);
        if (this._detached || !this._visible || this._coverKey !== key) { await challenge.removeLocal(path); return; }
        this._files = (this._files || []).concat(path); this.setData({ coverPath: path });
      } catch (_) {}
    },
    openEvent(event) { const id = event.currentTarget.dataset.id; if (/^ce_[a-f0-9]{32}$/.test(id || '')) wx.navigateTo({ url: '/pages/module/index?id=ai-challenge&event=' + id }); },
    changeFilter(event) { const filter = event.currentTarget.dataset.id; this.setData({ filter, events: (this._allEvents || []).filter(row => filter === 'all' || row.phase === filter) }); },
    loadMore() { if (!this.data.loading && this.data.hasMore) return this.load(true); },
    async back() { if (this.data.busy) return; clearTimeout(this._boundaryTimer); this._eventId = ''; this._dirty = false; this._coverKey = ''; this.clearFiles(); this.setData({ mode: 'list', selected: null, myTeam: null, teams: [], form: null, draftWork: null, scoreFile: null, scorePreview: null, coverPath: '', tab: 'overview' }); return this.load(); },
    async changeTab(event) {
      const tab = event.currentTarget.dataset.tab; this.setData({ tab, actionError: '' });
      if (['teams', 'works'].includes(tab) && this.data.selected?.canReview) return this.loadTeams(false);
      if (tab === 'teams' && !this.data.selected?.canReview) return this.loadMembers();
    },
    async loadTeams(more = false) {
      const epoch = this._epoch, eventId = this._eventId;
      try { const result = await challenge.call('teams', { eventId, offset: more === true ? this._teamOffset || 0 : 0 });
        if (this._detached || epoch !== this._epoch || eventId !== this._eventId) return;
        this._teamOffset = result.nextOffset; this.setData({ teams: (more === true ? this.data.teams : []).concat(result.teams.map(challenge.teamView)), teamsMore: result.hasMore });
      } catch (error) { if (!this._detached && epoch === this._epoch) this.setData({ teams: [], actionError: error.message }); }
    },
    loadMoreTeams() { return this.loadTeams(true); },
    async loadMembers() {
      const epoch = this._epoch, rows = []; let result, offset = 0;
      try { do { result = await challenge.call('members', { offset }); rows.push(...result.members); offset = result.nextOffset; } while (result.hasMore);
        if (this._detached || epoch !== this._epoch) return;
        this._selfId = result.selfId;
        this.setData({ leaderName: rows.find(row => row.id === result.selfId)?.name || '', members: rows.filter(row => row.id !== result.selfId).map(row => ({ ...row, selected: this.data.memberIds.includes(row.id) })),
          teacherChoices: rows.filter(row => row.id !== result.selfId) });
      } catch (error) { if (!this._detached && epoch === this._epoch) this.setData({ actionError: error.message }); }
    },
    editRegistration() { this.setData({ registerEdit: true }); return this.loadMembers(); },
    changeGroup(event) { this._dirty = true; this.setData({ groupName: event.detail.value }); },
    changeMembers(event) { this._dirty = true; const memberIds = event.detail.value; this.setData({ memberIds, members: this.data.members.map(row => ({ ...row, selected: memberIds.includes(row.id) })) }); },
    async register() {
      if (this.data.busy || !this.data.groupName.trim() || !this.data.selected?.canRegister) return;
      this.setData({ busy: true, actionError: '' });
      try { const result = await challenge.call('register', { eventId: this._eventId, name: this.data.groupName, memberIds: this.data.memberIds, revision: this.data.myTeam?.revision || 0 });
        if (this._detached) return; this._dirty = false; this.render(result); this.setData({ tab: 'works' }); wx.showToast({ title: '报名信息已保存', icon: 'success' });
      } catch (error) { if (!this._detached) this.setData({ actionError: error.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async editEvent() {
      if (!this.data.canManage || this.data.busy) return;
      this._epoch = (this._epoch || 0) + 1; clearTimeout(this._boundaryTimer);
      const selected = this.data.selected, [date, time] = nowInput();
      this.setData({ mode: 'editor', loading: false, actionError: '', form: { eventId: selected?.id || 'ce_' + challenge.newId(), revision: selected?.revision || 0,
        name: selected?.name || '', startDate: selected ? localInput(selected.startMs)[0] : date, startTime: selected ? localInput(selected.startMs)[1] : time,
        endDate: selected ? localInput(selected.endMs)[0] : date, endTime: selected ? localInput(selected.endMs)[1] : '23:59', cover: selected?.cover || null, intro: selected?.intro || null,
        timeLocked: !!selected?.groupCount } });
    },
    changeForm(event) { if (this.data.form) this.setData({ ['form.' + event.currentTarget.dataset.field]: event.detail.value }); },
    async chooseEventFile(event) {
      const kind = event.currentTarget.dataset.kind;
      if (!this.data.canManage || this.data.busy || !this.data.form || !['cover', 'intro'].includes(kind)) return;
      const eventId = this.data.form.eventId, scope = challenge.identityScope();
      const current = () => this.sameIdentity(scope) && this.data.mode === 'editor' && this.data.form?.eventId === eventId;
      this.setData({ busy: true, actionError: '' });
      try { const image = await challenge.chooseFile(kind);
        if (!current()) return;
        const file = await challenge.upload(image, eventId, kind);
        if (current()) this.setData({ ['form.' + kind]: file });
      } catch (error) { if (current() && !/cancel/.test(error.errMsg || '')) this.setData({ actionError: error.message || '文件上传失败。' }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async saveEvent() {
      const f = this.data.form; if (!f || !this.data.canManage || this.data.busy) return;
      const scope = challenge.identityScope();
      this.setData({ busy: true, actionError: '' });
      try { const startMs = Date.parse(f.startDate + 'T' + f.startTime + ':00+08:00'), endMs = Date.parse(f.endDate + 'T' + f.endTime + ':00+08:00');
        const result = await challenge.call('save', { eventId: f.eventId, revision: f.revision, name: f.name, startMs, endMs, coverFileId: f.cover?.id, introFileId: f.intro?.id });
        if (!this.sameIdentity(scope) || this.data.form?.eventId !== f.eventId) return; this._eventId = result.event.id; this.render(result); this.setData({ tab: 'overview', form: null }); wx.showToast({ title: '赛事已发布', icon: 'success' });
      } catch (error) { if (this.sameIdentity(scope)) this.setData({ actionError: error.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    cancelEditor() { if (!this.data.busy) { this.setData({ mode: this._eventId ? 'detail' : 'list', form: null }); return this._eventId ? this.load() : this.back(); } },
    async chooseWork() {
      if (this.data.busy || !this.data.myTeam?.canUpload) return;
      this.setData({ busy: true, actionError: '' });
      try { const picked = await challenge.chooseFile('work'), file = await challenge.upload(picked, this._eventId, 'work');
        if (!this._detached && this.data.myTeam?.canUpload) { this._requestId = ''; this.setData({ draftWork: file }); }
      } catch (error) { if (!this._detached && !/cancel/.test(error.errMsg || '')) this.setData({ actionError: error.message || '作品上传失败。' }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async submitWork() {
      if (this.data.busy || !this.data.myTeam?.canUpload || !this.data.draftWork) return;
      if (this.data.myTeam.work) { const result = await wx.showModal({ title: '更新本组作品？', content: '提交成功后将覆盖旧文件，组内成员只能查看最新作品。' }); if (!result.confirm) return; }
      this._requestId = this._requestId || challenge.newId(); this.setData({ busy: true, actionError: '' });
      try { const result = await challenge.call('submit', { eventId: this._eventId, fileId: this.data.draftWork.id, revision: this.data.myTeam.revision, requestId: this._requestId });
        if (this._detached) return; this._requestId = ''; this.setData({ draftWork: null }); this.render(result); wx.showToast({ title: '作品已提交', icon: 'success' });
      } catch (error) { if (!this._detached) this.setData({ actionError: error.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async chooseScores() {
      if (this.data.busy || !this.data.canManage || this.data.selected?.phase !== 'closed') return;
      this.setData({ busy: true, actionError: '' });
      try { const picked = await challenge.chooseFile('scores'), file = await challenge.upload(picked, this._eventId, 'scores');
        const preview = await challenge.call('previewResults', { eventId: this._eventId, fileId: file.id });
        if (!this._detached) this.setData({ scoreFile: file, scorePreview: preview });
      } catch (error) { if (!this._detached && !/cancel/.test(error.errMsg || '')) this.setData({ actionError: error.message || '评分表读取失败。' }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async publishResults() {
      if (this.data.busy || !this.data.scoreFile || !this.data.canManage || this.data.selected?.phase !== 'closed') return;
      const confirmation = await wx.showModal({ title: '公布评分与位次？', content: '评分表和组位次将向团队全部成员公开，作品文件继续保持私密。' }); if (!confirmation.confirm) return;
      this.setData({ busy: true, actionError: '' });
      try { const result = await challenge.call('publishResults', { eventId: this._eventId, fileId: this.data.scoreFile.id, revision: this.data.selected.results?.revision || 0 });
        if (this._detached) return; this.render(result); this.setData({ scoreFile: null, scorePreview: null }); wx.showToast({ title: '成绩已公布', icon: 'success' });
      } catch (error) { if (!this._detached) this.setData({ actionError: error.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async openFile(event) {
      if (this.data.downloadId || this.data.busy || !this.data.selected) return;
      const { kind, group } = event.currentTarget.dataset, selected = this.data.selected;
      const team = group ? this.data.teams.find(row => row.id === group) : this.data.myTeam;
      const file = kind === 'intro' ? selected.intro : kind === 'scores' ? selected.results?.file : team?.work?.file;
      if (!file) return; this.setData({ downloadId: file.id, progress: 0, actionError: '' });
      const epoch = this._epoch;
      try { const path = await challenge.download(selected.id, file, team?.id || '', progress => { if (!this._detached) this.setData({ progress }); });
        if (this._detached || !this._visible || epoch !== this._epoch) { await challenge.removeLocal(path); return; } this._files = (this._files || []).concat(path);
        if (file.ext === 'csv') await wx.shareFileMessage({ filePath: path, fileName: file.name });
        else await wx.openDocument({ filePath: path, fileType: file.ext, showMenu: kind === 'intro' || kind === 'scores' });
      } catch (error) { if (!this._detached) this.setData({ actionError: error.message || '文件读取失败。' }); }
      finally { if (!this._detached) this.setData({ downloadId: '' }); }
    },
    async openTeacher() { if (!this.data.canManage || this.data.busy) return; this._epoch = (this._epoch || 0) + 1; clearTimeout(this._boundaryTimer); this.setData({ mode: 'teacher', loading: false, teacherIndex: -1, actionError: '' }); return this.loadMembers(); },
    changeTeacher(event) { this.setData({ teacherIndex: Number(event.detail.value) }); },
    async bindTeacher() {
      const member = this.data.teacherChoices[this.data.teacherIndex]; if (!member || !this.data.canManage || this.data.busy) return;
      const confirmation = await wx.showModal({ title: '确认陈老师账号', content: member.name + '\n' + member.id + '\n请核实本人身份。绑定后可查看全部报名和作品。' }); if (!confirmation.confirm) return;
      this.setData({ busy: true, actionError: '' });
      try { await challenge.call('bindTeacher', { teacherId: member.id, revision: this.data.teacher?.revision || 0 }); if (!this._detached) await this.load(); }
      catch (error) { if (!this._detached) this.setData({ actionError: error.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    retry() { return this.load(); }
  }
});
