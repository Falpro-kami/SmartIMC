const weekly = require('../../services/weekly');
const formModel = require('../../utils/weekly-form');
Component({
  properties: { initialPeriod: { type: String, value: '' }, initialView: { type: String, value: 'detail' }, initialOwner: { type: String, value: '' } },
  data: { mode: 'list', loading: true, busy: false, error: '', actionError: '', saveState: '', periods: [], hasMore: false,
    isLeader: false, canManage: false, canReadTeam: false, canRemind: false, canExport: false, selected: null, report: null, own: true,
    files: [], answers: {}, imageURLs: {}, templatesOpen: false, choosingTemplate: false, formUploading: false, versions: [], rows: [], filteredRows: [], filter: 'all', total: 0, submitted: 0, form: null, members: [], memberQuery: '', shownMembers: [] },
  lifetimes: { attached() { this.startLive(); this.initialize(); }, detached() { clearTimeout(this._draftTimer); this.flushForm(); this._detached = true; this.stopLive(); this._epoch = (this._epoch || 0) + 1; } },
  pageLifetimes: {
    show() { this.startLive(); if (!this._initializing && !this.data.busy && !this._choosing && !this._nativeFile && !this._unsaved && !this._formDirty && !this._formPending && !this._formSave && this.data.mode !== 'form') {
      const force = this._livePending === true; this._livePending = false;
      if (this._initialized) this.refresh(force, true); else this.initialize(force);
    } },
    hide() { clearTimeout(this._draftTimer); this.flushForm(); if (this._initializing) this._initialInterrupted = true; this.stopLive(); this._epoch = (this._epoch || 0) + 1; }
  },
  methods: {
    async initialize(force = false) {
      if (this._initializing || this._detached) return;
      this._initializing = true;
      this._initialInterrupted = false;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      try {
        const periodId = this.properties.initialPeriod;
        if (!periodId) return await this.loadList(false, force);
        this._initialized = true;
        if (this.properties.initialView !== 'team') return await this.openPeriod(periodId, this.properties.initialOwner || '', force);
        this.update({ mode: 'team', loading: true, error: '' });
        const result = await weekly.call('get', { periodId }, force);
        if (this._detached || epoch !== this._epoch) return;
        this.update({ ...this.rights(result), selected: weekly.periodView(result.period) });
        if (!this.data.canReadTeam) throw new Error('没有查看团队周报的权限。');
        await this.loadTeam(force);
      } catch (error) { if (!this._detached && epoch === this._epoch) this.update({ error: error.message, loading: false }); }
      finally {
        this._initializing = false;
        if (this._initialInterrupted && this._visible && !this._detached) { this._initialInterrupted = false; this.refresh(false, true); }
        else this.refreshLive();
      }
    },
    navigateWeekly(periodId = '', view = 'detail', ownerId = '', replace = false) {
      if (this.data.busy || this._navigating || this._detached ||
        (periodId && !/^wp_[a-f0-9]{32}$/.test(periodId)) || (ownerId && !/^user_[a-f0-9]{32}$/.test(ownerId))) return;
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const matches = page => {
        const options = page.options || {};
        return page.route === 'pages/module/index' && options.id === 'weekly' && (options.period || '') === periodId &&
          (!periodId || ((options.view === 'team' ? 'team' : 'detail') === view && (view === 'team' || (options.owner || '') === ownerId)));
      };
      let delta = 0;
      for (let i = pages.length - 2; i >= 0; i--) if (matches(pages[i])) { delta = pages.length - 1 - i; break; }
      this._navigating = true;
      const callbacks = {
        fail: () => { if (this._detached) wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }); else this.update({ actionError: '页面打开失败，请重试。' }); },
        complete: () => { this._navigating = false; }
      };
      if (delta) return wx.navigateBack({ delta, ...callbacks });
      if (!periodId && pages.length && matches(pages[pages.length - 1])) { this._navigating = false; return this.loadList(); }
      const url = '/pages/module/index?id=weekly' + (periodId ? '&period=' + periodId + (view === 'team' ? '&view=team' : ownerId ? '&owner=' + ownerId : '') : '');
      // A notification may open a period without a list ancestor. Replace the flow's
      // first weekly page so "周报列表" cannot lead back into a stale member detail.
      if (replace && !periodId) {
        let root = pages.length - 1;
        while (root > 0 && pages[root - 1].route === 'pages/module/index' && (pages[root - 1].options || {}).id === 'weekly') root--;
        if (root < pages.length - 1) return wx.navigateBack({ delta: pages.length - 1 - root,
          success: () => wx.redirectTo({ url, ...callbacks }), fail: callbacks.fail,
          complete: result => { if (/fail/.test(result.errMsg || '')) callbacks.complete(); }
        });
      }
      return replace ? wx.redirectTo({ url, ...callbacks }) : wx.navigateTo({ url, ...callbacks });
    },
    startLive() {
      this._visible = true;
      if (!this._unsubscribeLive && weekly.subscribe) this._unsubscribeLive = weekly.subscribe(() => { this._livePending = true; this.refreshLive(); });
    },
    stopLive() { this._visible = false; if (this._unsubscribeLive) this._unsubscribeLive(); this._unsubscribeLive = null; },
    async refreshLive() {
      if (!this._livePending || this._initializing || this._liveLoading || this._detached || !this._unsubscribeLive || this.data.loading || this.data.busy || this._choosing || this._nativeFile || this._unsaved || this._formDirty || this._formPending || this._formSave || this.data.mode === 'form') return;
      this._livePending = false;
      this._liveLoading = true;
      try { await this.refresh(true, true); }
      finally { this._liveLoading = false; this.refreshLive(); }
    },
    update(data) { if (!this._detached) { this.setData(data); if (data.busy === false || data.loading === false) this.refreshLive(); } },
    async refresh(force = false, quiet = false) {
      if (this._initializing) return;
      if (this.properties.initialPeriod && (!this.data.selected || this.properties.initialView === 'team' && !this.data.canReadTeam)) return this.initialize(force === true);
      if (this.data.mode === 'form') return;
      if (this.data.mode === 'team' && this.data.selected) return this.loadTeam(force === true, quiet);
      if (this.data.mode === 'detail' && this.data.selected) return this.openPeriod(this.data.selected.id, this._ownerId, force === true, quiet);
      return this.loadList(false, force === true, quiet);
    },
    async loadList(more = false, force = false, quiet = false) {
      if (this.data.busy || (more && (this.data.loading || !this.data.hasMore))) return;
      const retainedOffset = this._offset || 0;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      const cached = !more && weekly.peek && weekly.peek('list', { offset: 0 });
      if (cached && (!quiet || !this.data.periods.length)) { this._offset = cached.nextOffset; this.update({ ...this.rights(cached), periods: cached.periods.map(weekly.periodView), hasMore: cached.hasMore }); }
      this.update({ mode: 'list', loading: quiet ? false : !cached && (!this.data.periods.length || more), error: '', actionError: '' });
      try {
        let result = await weekly.call('list', { offset: more ? this._offset : 0 }, force);
        if (quiet && !more) {
          const target = retainedOffset, rows = result.periods.slice();
          while (result.hasMore && result.nextOffset < target) {
            result = await weekly.call('list', { offset: result.nextOffset }, force);
            if (this._detached || epoch !== this._epoch) return;
            rows.push(...result.periods);
          }
          result = { ...result, periods: Array.from(new Map(rows.map(row => [row.id, row])).values()) };
        }
        if (this._detached || epoch !== this._epoch) return;
        this._offset = result.nextOffset;
        this.update({ ...this.rights(result), periods: (more ? this.data.periods : []).concat(result.periods.map(weekly.periodView)), hasMore: result.hasMore });
        if (!this._initialized) {
          this._initialized = true;
        }
      } catch (error) { if (epoch === this._epoch && (!quiet || ['MEMBERSHIP_REQUIRED', 'FORBIDDEN'].includes(error.code))) this.update({ error: error.message, periods: [], canManage: false }); }
      finally { if (epoch === this._epoch) this.update({ loading: false }); }
    },
    rights(r) { return { isLeader: r.isLeader === true, canManage: !!r.canManage, canReadTeam: !!r.canReadTeam, canRemind: !!r.canRemind, canExport: !!r.canExport }; },
    loadMore() { return this.loadList(true); },
    choosePeriod(e) { return this.navigateWeekly(e.currentTarget.dataset.id); },
    openTeam() { if (this.data.selected && this.data.canReadTeam) return this.navigateWeekly(this.data.selected.id, 'team'); },
    async openPeriod(periodId, ownerId = '', force = false, quiet = false) {
      if (this.data.busy) return;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this._ownerId = ownerId;
      this._unsaved = null;
      const query = { periodId, ...(ownerId ? { ownerId } : {}) }, cached = weekly.peek && weekly.peek('get', query);
      if (cached) this.accept(cached);
      if (!quiet) this.update({ mode: 'detail', loading: !cached, error: '', actionError: '', ...(cached ? {} : { selected: null, report: null, files: [], versions: [] }), saveState: '' });
      try {
        const result = await weekly.call('get', query, force);
        if (epoch === this._epoch && !this._detached) {
          if (quiet && (this.data.busy || this._choosing || this._nativeFile || this._unsaved || this._formDirty || this._formPending || this._formSave || this.data.mode !== 'detail')) { this._livePending = true; return; }
          this.accept(result);
        }
      } catch (error) { if (epoch === this._epoch && (!quiet || ['MEMBERSHIP_REQUIRED', 'FORBIDDEN'].includes(error.code))) this.update({ error: error.message }); }
      finally { if (epoch === this._epoch) this.update({ loading: false }); }
    },
    accept(result) {
      this._draftRevision = result.report ? result.report.revision : 0;
      this.update({ ...this.rights(result), selected: weekly.periodView(result.period), report: result.report, own: result.own, ownerName: result.ownerName,
        answers: result.report && result.report.answers || {}, imageURLs: result.imageURLs || {},
        files: (result.report ? result.report.files : []).map(weekly.fileView), submittedLabel: weekly.dateLabel(result.report && result.report.submittedMs),
        versions: result.versions.map(v => ({ ...v, dateLabel: weekly.dateLabel(v.submittedMs), files: v.files.map(weekly.fileView) })) });
    },
    async addFiles() {
      if (this.data.busy || !this.data.own || !this.data.selected.canEdit || this._unsaved) return;
      if (this.data.files.length >= 5) { this.update({ actionError: '最多上传5个文件。' }); return; }
      this._choosing = true;
      try {
        const chosen = await wx.chooseMessageFile({ count: 5 - this.data.files.length, type: 'file', extension: ['doc', 'docx', 'pdf'] });
        if (this._detached) return;
        this.update({ busy: true, actionError: '', saveState: '正在上传…' });
        for (const file of chosen.tempFiles) {
          if (file.size > 5 * 1024 * 1024 || !/\.(pdf|docx?)$/i.test(file.name || '')) throw new Error('支持 Word、PDF 文档，单个文件不超过5MB。');
          if (this.data.files.reduce((n, f) => n + f.size, 0) + file.size > 10 * 1024 * 1024) throw new Error('每份周报附件合计不超过10MB。');
          const periodId = this.data.selected.id, revision = this.data.report ? this.data.report.revision : 0;
          const uploaded = await weekly.upload(file, periodId);
          const files = this.data.files.concat(uploaded);
          this._unsaved = { periodId, revision, fileIds: files.map(f => f.id), requestId: weekly.newId('wd') };
          this.update({ files, saveState: '正在自动保存…' });
          // Finish the cloud save even when the user leaves during upload.
          const result = await weekly.call('saveDraft', this._unsaved);
          this._unsaved = null;
          this.accept(result);
          this.update({ saveState: '已自动保存' });
          if (this._detached) break;
        }
      } catch (error) { if (!/cancel/i.test(error.errMsg || '')) this.update({ actionError: error.message || '文件上传失败，请重试。', saveState: this._unsaved ? '自动保存失败' : '' }); }
      finally { this._choosing = false; this.update({ busy: false }); }
    },
    async removeFile(e) {
      if (this.data.busy || this._unsaved || !this.data.own || !this.data.selected.canEdit) return;
      const files = this.data.files.filter(f => f.id !== e.currentTarget.dataset.id);
      this._unsaved = { periodId: this.data.selected.id, revision: this.data.report ? this.data.report.revision : 0, fileIds: files.map(f => f.id), requestId: weekly.newId('wd') };
      this.update({ files });
      return this.retrySave();
    },
    async retrySave() {
      if (this.data.selected && this.data.selected.schema) return this.flushForm();
      if (!this._unsaved || this.data.busy) return;
      this.update({ busy: true, actionError: '', saveState: '正在自动保存…' });
      try {
        const result = await weekly.call('saveDraft', this._unsaved);
        this._unsaved = null;
        this.accept(result);
        this.update({ saveState: '已自动保存' });
      } catch (error) { this.update({ actionError: error.message, saveState: '自动保存失败' }); }
      finally { this.update({ busy: false }); }
    },
    async submit() {
      if (this.data.busy || this._unsaved || this._formUploading || !this.data.own || !this.data.selected.canEdit || (!this.data.selected.schema && !this.data.files.length)) return;
      clearTimeout(this._draftTimer);
      if (this.data.selected.schema) { while (this._formSave || this._formPending || this._formDirty) if (!await this.flushForm()) return; }
      this.update({ busy: true, actionError: '' });
      try {
        const revision = this.data.report ? this.data.report.revision : 0;
        if (!this._submitToken || this._submitRevision !== revision) { this._submitToken = weekly.newId('ws'); this._submitRevision = revision; }
        const result = await weekly.call('submit', { periodId: this.data.selected.id, revision, fileIds: this.data.files.map(f => f.id), ...(this.data.selected.schema ? { answers: this.data.answers } : {}), requestId: this._submitToken });
        this.accept(result);
        this.update({ saveState: '' });
        if (!this._detached) wx.showToast({ title: '周报已提交', icon: 'success' });
      } catch (error) { this.update({ actionError: error.message }); }
      finally { this.update({ busy: false }); }
    },
    answersChange(e) {
      if (this.data.busy || !this.data.own || !this.data.selected.canEdit) return;
      this._formDirty = true; this._formGeneration = (this._formGeneration || 0) + 1;
      this.update({ answers: e.detail.answers, saveState: '正在自动保存…', actionError: '' });
      clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => this.flushForm(), 700);
    },
    formUpload(e) { this._uploads = Math.max(0, (this._uploads || 0) + (e.detail.value ? 1 : -1)); this._formUploading = this._uploads > 0; this._choosing = this._formUploading; this.update({ formUploading: this._formUploading }); if (!this._formUploading && this._formDirty) this.flushForm(); },
    flushForm() {
      if (this._formSave) return this._formSave;
      if (!this.data.selected || !this.data.selected.schema || !this.data.own || this._formUploading || this.data.busy || (!this._formDirty && !this._formPending)) return Promise.resolve(true);
      if (!this._formPending) {
        this._formPending = { periodId: this.data.selected.id, revision: this._draftRevision || 0, answers: JSON.parse(JSON.stringify(this.data.answers)), requestId: weekly.newId('wd') };
        this._savingGeneration = this._formGeneration; this._formDirty = false;
      }
      this.update({ saveState: '正在自动保存…', actionError: '' });
      let failed = false;
      this._formSave = weekly.call('saveDraft', this._formPending).then(result => {
        this._draftRevision = result.report.revision; this._formPending = null;
        if (this._savingGeneration === this._formGeneration) { this.accept(result); this.update({ saveState: '已自动保存' }); }
        else this.update({ report: result.report, saveState: '正在自动保存…' });
        return true;
      }).catch(error => { failed = true; if (['INVALID_FORM', 'FILE_LIMIT', 'INVALID_INPUT'].includes(error.code)) { this._formPending = null; this._formDirty = true; } this.update({ saveState: '自动保存失败', actionError: error.message }); return false; })
        .finally(() => { this._formSave = null; if (this._formDirty && !failed) this.flushForm(); else this.refreshLive(); });
      return this._formSave;
    },
    fieldFile(e) { return this.useFile({ currentTarget: { dataset: e.detail } }); },
    async toggleVersion(e) {
      if (this.data.busy) return;
      const version = this.data.versions.find(v => v.id === e.currentTarget.dataset.id);
      if (!version) return;
      if (version.expanded) { this.update({ versions: this.data.versions.map(v => v.id === version.id ? { ...v, expanded: false } : v) }); return; }
      this.update({ busy: true, actionError: '' });
      try { const r = await weekly.call('getVersion', { versionId: version.id }); this.update({ versions: this.data.versions.map(v => v.id === version.id ? { ...v, ...r.version, imageURLs: r.imageURLs, expanded: true } : v) }); }
      catch (e) { this.update({ actionError: e.message }); }
      finally { this.update({ busy: false }); }
    },
    manageTemplates() { if (this.data.canManage && !this.data.busy) { this._choosing = true; this.update({ templatesOpen: true, choosingTemplate: this.data.mode === 'form' }); } },
    closeTemplates() { this._choosing = false; this.update({ templatesOpen: false }); this.refreshLive(); },
    selectTemplate(e) { if (!this.data.form) return; this.update({ 'form.schema': e.detail.schema, 'form.templateName': e.detail.name }); this.closeTemplates(); },
    async useFile(e) {
      if (this.data.busy) return;
      this._nativeFile = true;
      this.update({ busy: true, actionError: '' });
      try {
        const file = await weekly.download(e.currentTarget.dataset.id, e.currentTarget.dataset.version);
        if (this._detached) return;
        if (e.currentTarget.dataset.share) {
          if (typeof wx.shareFileMessage !== 'function') throw new Error('请在新版手机微信中导出文件。');
          await wx.shareFileMessage({ filePath: file.filePath, fileName: file.fileName });
        } else if (['jpg', 'jpeg', 'png'].includes(file.ext)) await wx.previewImage({ urls: [file.filePath] });
        else await wx.openDocument({ filePath: file.filePath, fileType: file.ext, showMenu: true });
      } catch (error) { if (!/cancel/i.test(error.errMsg || '')) this.update({ actionError: error.message || '文件暂时无法打开，请下载后查看。' }); }
      finally { this._nativeFile = false; this.update({ busy: false }); }
    },
    async loadTeam(force = false, quiet = false) {
      if (this.data.busy || !this.data.selected || !this.data.canReadTeam) return;
      const periodId = this.data.selected.id, epoch = this._epoch = (this._epoch || 0) + 1;
      const cached = weekly.peek && weekly.peek('team', { periodId });
      if (cached) this.acceptTeam(cached);
      this.update({ mode: 'team', loading: quiet ? false : !cached, error: '', actionError: '' });
      try {
        const result = await weekly.call('team', { periodId }, force === true);
        if (epoch !== this._epoch) return;
        this.acceptTeam(result);
      } catch (error) { if (epoch === this._epoch && (!quiet || ['MEMBERSHIP_REQUIRED', 'FORBIDDEN'].includes(error.code))) this.update({ error: error.message }); }
      finally { if (epoch === this._epoch) this.update({ loading: false }); }
    },
    acceptTeam(result) { const previous = new Map(this.data.rows.map(r => [r.id, r])); const rows = result.rows.map(r => { const old = previous.get(r.id); return { ...r, ...(old && old.version === r.version && old.status === r.status ? { expanded: old.expanded || false, detail: old.detail || null } : {}), statusLabel: weekly.statusLabel(r.status), dateLabel: weekly.dateLabel(r.submittedMs) }; });
      this.update({ selected: weekly.periodView(result.period), rows, total: result.total, submitted: result.submitted }); this.applyFilter(); },
    async toggleTeamContent(e) {
      const row = this.data.rows.find(r => r.id === e.currentTarget.dataset.id);
      if (!row || row.status !== 'submitted' || this.data.busy) return;
      if (row.expanded) { this.update({ rows: this.data.rows.map(r => r.id === row.id ? { ...r, expanded: false } : r) }); this.applyFilter(); return; }
      this.update({ busy: true, actionError: '' });
      try {
        const result = await weekly.call('get', { periodId: this.data.selected.id, ownerId: row.id });
        this.update({ rows: this.data.rows.map(r => r.id === row.id ? { ...r, expanded: true, detail: result } : r) }); this.applyFilter();
      } catch (error) { this.update({ actionError: error.message }); }
      finally { this.update({ busy: false }); }
    },
    setFilter(e) { this.update({ filter: e.currentTarget.dataset.value }); this.applyFilter(); },
    applyFilter() { this.update({ filteredRows: this.data.rows.filter(r => this.data.filter === 'all' || (this.data.filter === 'pending' ? ['draft', 'unsubmitted'].includes(r.status) : r.status === this.data.filter)) }); },
    openTeamReport(e) { const row = this.data.rows.find(r => r.id === e.currentTarget.dataset.id); if (row && row.status === 'submitted' && this.data.selected && this.data.canReadTeam) return this.navigateWeekly(this.data.selected.id, 'detail', row.id); },
    async remind() {
      if (this.data.busy || !this.data.canRemind) return;
      this.update({ busy: true, actionError: '' });
      try {
        const confirm = await wx.showModal({ title: '催交周报', content: '向本周期尚未提交的成员发送消息提醒？', confirmText: '发送' });
        if (!confirm.confirm || this._detached) return;
        const result = await weekly.call('remind', { periodId: this.data.selected.id });
        if (!this._detached) wx.showToast({ title: result.count ? '提醒已发送' : '暂无需要催交的成员', icon: 'none' });
      } catch (error) { this.update({ actionError: error.message }); }
      finally { this.update({ busy: false }); }
    },
    async exportStats() {
      if (this.data.busy || !this.data.canExport) return;
      this._nativeFile = true;
      this.update({ busy: true, actionError: '' });
      try {
        const file = await weekly.exportStats(this.data.selected.id);
        if (this._detached) return;
        if (typeof wx.shareFileMessage === 'function') await wx.shareFileMessage(file);
        else if (typeof wx.saveFileToDisk === 'function') await wx.saveFileToDisk({ filePath: file.filePath });
        else throw new Error('请在新版手机微信中导出统计。');
      } catch (error) { if (!/cancel/i.test(error.errMsg || '')) this.update({ actionError: error.message || '导出失败，请重试。' }); }
      finally { this._nativeFile = false; this.update({ busy: false }); }
    },
    newPeriod() { return this.editPeriod(false); },
    editCurrentPeriod() { return this.editPeriod(true); },
    async editPeriod(existing) {
      if (this.data.busy || !this.data.canManage) return;
      this._epoch = (this._epoch || 0) + 1;
      const currentId = this.data.selected && this.data.selected.id;
      this.update({ busy: true, actionError: '' });
      try {
        const roster = await weekly.call('roster');
        let form;
        if (existing) {
          const result = await weekly.call('configuration', { periodId: currentId });
          const p = result.period, deadline = weekly.dateLabel(p.deadlineMs);
          const publish = weekly.dateLabel(p.publishAtMs);
          form = { ...p, scheduled: p.status === 'scheduled', canSchedule: ['scheduled', 'cancelled'].includes(p.status), publishDate: p.publishAtMs ? publish.slice(0, 10) : new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), publishTime: p.publishAtMs ? publish.slice(11) : '18:00',
            deadlineDate: deadline.slice(0, 10), deadlineTime: deadline.slice(11), statusIndex: Math.max(0, ['open', 'closed', 'archived'].indexOf(p.status)) };
          const known = new Set(roster.members.map(m => m.id));
          roster.members.push(...p.roster.filter(m => !known.has(m.id)));
        } else {
          const today = new Date(Date.now() + 8 * 3600000);
          const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000;
          const date = new Date(monday).toISOString().slice(0, 10), end = new Date(monday + 6 * 86400000).toISOString().slice(0, 10);
          form = { id: weekly.newId('wp'), revision: 0, title: date + ' 至 ' + end + ' 周报', startDate: date, endDate: end, deadlineDate: end,
            schema: formModel.defaults(), templateName: '默认表单',
            deadlineTime: '18:00', status: 'open', statusIndex: 0, scheduled: false, canSchedule: true, publishDate: today.toISOString().slice(0, 10),
            publishTime: new Date(today.getTime() + 10 * 60000).toISOString().slice(11, 16), allowLateSubmit: true, allowLateEdit: false, roster: [] };
        }
        const members = roster.members.map(m => { const selected = form.roster.find(r => r.id === m.id); return { ...m, selected: existing ? !!selected : true, exempt: selected && selected.exempt || '' }; });
        this.update({ mode: 'form', form, members, memberQuery: '', shownMembers: members, error: '', actionError: '' });
      } catch (error) { this.update({ actionError: error.message }); }
      finally { this.update({ busy: false }); }
    },
    formInput(e) { const field = e.currentTarget.dataset.field; if (['title', 'startDate', 'endDate', 'deadlineDate', 'deadlineTime', 'publishDate', 'publishTime', 'allowLateSubmit', 'allowLateEdit'].includes(field)) this.update({ ['form.' + field]: e.detail.value }); },
    scheduleInput(e) { this.update({ 'form.scheduled': e.detail.value, 'form.status': e.detail.value ? 'scheduled' : 'open' }); },
    statusInput(e) { const index = Number(e.detail.value); if (index >= 0 && index < 3) this.update({ 'form.statusIndex': index, 'form.status': ['open', 'closed', 'archived'][index] }); },
    searchMembers(e) { this.update({ memberQuery: e.detail.value }); this.filterMembers(); },
    filterMembers() { this.update({ shownMembers: this.data.members.filter(m => m.name.includes(this.data.memberQuery.trim())) }); },
    toggleMember(e) { const id = e.currentTarget.dataset.id; this.update({ members: this.data.members.map(m => m.id === id ? { ...m, selected: !m.selected } : m) }); this.filterMembers(); },
    exemptionInput(e) { const id = e.currentTarget.dataset.id; this.update({ members: this.data.members.map(m => m.id === id ? { ...m, exempt: e.detail.value } : m) }); this.filterMembers(); },
    async cancelScheduled() {
      if (this.data.busy || !this.data.form || this.data.form.status !== 'scheduled') return;
      const result = await wx.showModal({ title: '取消定时发布', content: '确定取消这份周报的定时发布？', confirmText: '取消发布', confirmColor: '#ad4037' });
      if (result.confirm) return this.savePeriod('cancelled');
    },
    async savePeriod(override) {
      if (this.data.busy || !this.data.form || !this.data.canManage) return;
      const f = this.data.form;
      this.update({ busy: true, actionError: '' });
      try {
        const result = await weekly.call('savePeriod', { id: f.id, revision: f.revision, title: f.title, startDate: f.startDate, endDate: f.endDate,
          deadline: f.deadlineDate + 'T' + f.deadlineTime, status: override === 'cancelled' ? 'cancelled' : f.status, allowLateSubmit: f.allowLateSubmit, allowLateEdit: f.allowLateEdit,
          publishAt: f.scheduled ? f.publishDate + 'T' + f.publishTime : '',
          schema: f.schema || null, templateName: f.templateName || '',
          roster: this.data.members.filter(m => m.selected).map(m => ({ id: m.id, exempt: m.exempt })) });
        this.update({ busy: false, form: null });
        if (!this.properties.initialPeriod) {
          await this.loadList(false, true);
          if (!this._detached) this.navigateWeekly(result.id);
        } else await this.openPeriod(result.id, this.properties.initialOwner || this._ownerId || '');
      } catch (error) { this.update({ actionError: error.message }); }
      finally { this.update({ busy: false }); }
    },
    async backToList() {
      if (this.data.busy) return;
      if (this._unsaved || this.data.mode === 'form') {
        const confirm = await wx.showModal({ title: '返回周报列表', content: this._unsaved ? '附件尚未保存成功，确定离开？' : '本次周期设置尚未发布，确定离开？', confirmText: '离开' });
        if (!confirm.confirm) return;
      }
      this._unsaved = null;
      return this.navigateWeekly('', 'detail', '', true);
    }
  }
});
