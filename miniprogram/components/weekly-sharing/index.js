const sharing = require('../../services/sharing');
Component({
  properties: { initialTask: { type: String, value: '' } },
  data: { mode: 'list', loading: true, busy: false, error: '', actionError: '', tasks: [], selected: null, canManage: false, isReviewer: false,
    filter: 'all', mine: false, hasMore: false, filters: [{ id: 'all', label: '全部' }, { id: 'pending', label: '待完成' }, { id: 'completed', label: '已完成' }, { id: 'incomplete', label: '未完成' }, { id: 'archived', label: '已归档' }],
    calendarMonth: sharing.monthKey(), calendarWeeks: [], selectedWeek: '', weekdays: ['一', '二', '三', '四', '五', '六', '日'], calendar: sharing.calendar(sharing.monthKey(), []),
    form: null, members: [], selectedMemberIds: [], roster: null, importMessage: '', files: [], cover: null, coverPath: '', title: '', note: '', comment: '', downloadId: '', progress: 0 },
  lifetimes: {
    attached() { this._visible = true; this._taskId = this.properties.initialTask; this.startLive(); this.load(); },
    detached() { this._detached = true; this._epoch = (this._epoch || 0) + 1; this.stopLive(); this.clearLocal(); }
  },
  pageLifetimes: {
    show() { this._visible = true; this.startLive(); if (this._initialized && !this.data.busy && !this.data.downloadId && !['schedule', 'roster'].includes(this.data.mode)) this.load(); },
    hide() { this._visible = false; this._epoch = (this._epoch || 0) + 1; this.stopLive(); }
  },
  methods: {
    startLive() {
      if (!this._unsubscribe) this._unsubscribe = sharing.subscribe(() => {
        if (!this.data.busy && !['schedule', 'roster'].includes(this.data.mode) && !this.data.downloadId) this.load();
      });
      if (!this._unsubscribeMembers) this._unsubscribeMembers = sharing.subscribeMembers(() => {
        this._dirty = false; this._requestId = null;
        this._coverKey = '';
        this.setData({ selected: null, tasks: [], calendarWeeks: [], calendar: sharing.calendar(this.data.calendarMonth, []), files: [], cover: null, coverPath: '', title: '', note: '', comment: '', canManage: false, isReviewer: false });
        this.clearLocal(); this.load();
      });
    },
    stopLive() { if (this._unsubscribe) this._unsubscribe(); if (this._unsubscribeMembers) this._unsubscribeMembers(); this._unsubscribe = this._unsubscribeMembers = null; },
    async clearLocal() { const paths = this._localFiles || []; this._localFiles = []; for (const path of paths) await sharing.removeLocal(path); },
    async refresh() { if (!this.data.busy && !this._dirty) return this.load(); },
    async load(more = false) {
      more = more === true;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: !(this._dirty && this._initialized), error: '', actionError: '' });
      try {
        if (this._taskId && !more) {
          const result = await sharing.call('get', { taskId: this._taskId });
          if (this._detached || epoch !== this._epoch) return;
          this.renderDetail(result);
        } else {
          const query = { filter: this.data.filter, mine: this.data.mine };
          const [result, monthResult] = await Promise.all([
            sharing.call('list', { ...query, ...(this.data.selectedWeek ? { weekStart: this.data.selectedWeek } : {}), offset: more ? this._offset || 0 : 0 }),
            more ? Promise.resolve({ tasks: this.data.calendarWeeks }) : sharing.call('list', { ...query, month: this.data.calendarMonth })
          ]);
          if (this._detached || epoch !== this._epoch) return;
          this._offset = result.nextOffset;
          const calendarWeeks = monthResult.tasks || [];
          this.setData({ mode: 'list', tasks: sharing.sortTasks((more ? this.data.tasks : []).concat(result.tasks.map(sharing.taskView))),
            calendarWeeks, calendar: sharing.calendar(this.data.calendarMonth, calendarWeeks, this.data.selectedWeek),
            hasMore: result.hasMore, canManage: result.canManage, isReviewer: result.isReviewer });
        }
        this._initialized = true;
      } catch (error) { if (!this._detached && epoch === this._epoch) { this._dirty = false; this._requestId = null; this._coverKey = ''; this.setData({ error: error.message, selected: null, tasks: [], calendarWeeks: [], calendar: sharing.calendar(this.data.calendarMonth, []), canManage: false, isReviewer: false, files: [], cover: null, coverPath: '', title: '', note: '', comment: '' }); this.clearLocal(); } }
      finally { if (!this._detached && epoch === this._epoch) this.setData({ loading: false }); }
    },
    renderDetail(result) {
      const selected = sharing.taskView(result.task), submission = selected.submission;
      const preserve = this._dirty && selected.canUpload;
      if (!selected.canUpload) { this._dirty = false; this._requestId = null; }
      this.setData({ mode: 'detail', selected, canManage: result.canManage, isReviewer: result.isReviewer, loading: false,
        ...(!preserve ? { files: selected.canUpload && submission ? submission.files : [], cover: selected.canUpload && submission ? submission.cover || null : null,
          title: selected.canUpload && submission ? submission.title : '', note: selected.canUpload && submission ? submission.note : '' } : {}), comment: '' });
      if (!preserve) this.loadCover(selected.id, submission && submission.cover);
    },
    async loadCover(taskId, cover) {
      const key = cover ? taskId + ':' + cover.id : '';
      if (key && this._coverKey === key && this.data.coverPath) return;
      this._coverKey = key; this.setData({ coverPath: '' });
      if (!cover) return;
      try {
        const path = await sharing.download(taskId, cover);
        if (this._detached || this._coverKey !== key) { await sharing.removeLocal(path); return; }
        this._localFiles = (this._localFiles || []).concat(path); this.setData({ coverPath: path });
      } catch (error) { if (!this._detached && this._coverKey === key) this.setData({ actionError: error.message || '封面读取失败，请重新打开。' }); }
    },
    async chooseCover() {
      if (this.data.busy || !this.data.selected || !this.data.selected.canUpload) return;
      this.setData({ busy: true, actionError: '' });
      try {
        const image = await sharing.chooseCover();
        const cover = await sharing.upload(image, this.data.selected.id, 'cover');
        if (this._detached || !this.data.selected || !this.data.selected.canUpload) return;
        this._dirty = true; this._requestId = null; this._coverKey = this.data.selected.id + ':' + cover.id;
        this.setData({ cover, coverPath: image.path });
      } catch (error) { if (!this._detached && !/cancel/.test(error.errMsg || '')) this.setData({ actionError: error.message || '封面上传失败，请重试。' }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    changeFilter(event) { if (this.data.busy) return; this.setData({ filter: event.currentTarget.dataset.id }); this.load(); },
    changeMonth(event) {
      if (this.data.busy) return;
      const calendarMonth = sharing.shiftMonth(this.data.calendarMonth, Number(event.currentTarget.dataset.step));
      this.setData({ calendarMonth, selectedWeek: '', calendar: sharing.calendar(calendarMonth, []) }); return this.load();
    },
    currentMonth() { this.setData({ calendarMonth: sharing.monthKey(), selectedWeek: '' }); return this.load(); },
    selectDay(event) {
      if (this.data.busy) return;
      const day = this.data.calendar.days.find(day => day.date === event.currentTarget.dataset.date);
      if (!day || !day.hasTask) return;
      this.setData({ selectedWeek: this.data.selectedWeek === day.weekStart ? '' : day.weekStart }); return this.load();
    },
    clearWeek() { this.setData({ selectedWeek: '' }); return this.load(); },
    toggleMine(event) { this.setData({ mine: event.detail.value }); this.load(); },
    loadMore() { if (!this.data.loading && this.data.hasMore && !this.data.busy) return this.load(true); },
    openTask(event) {
      const task = this.data.tasks.find(row => row.id === event.currentTarget.dataset.id);
      if (task) wx.navigateTo({ url: '/pages/module/index?id=weekly-sharing&task=' + task.id });
    },
    backToList() {
      if (this.data.busy) return;
      const leave = () => { this._dirty = false; this._requestId = null; this._coverKey = ''; this._taskId = ''; this.setData({ mode: 'list', form: null, selected: null, files: [], cover: null, coverPath: '', title: '', note: '' }); this.clearLocal(); this.load(); };
      if (this._dirty) wx.showModal({ title: '放弃本次编辑？', content: '尚未提交的修改将被清空。', success: result => { if (result.confirm) leave(); } });
      else leave();
    },
    async openSchedule() {
      if (!this.data.canManage || this.data.busy) return;
      const selected = this.data.mode !== 'list' && this.data.selected;
      if (selected && !selected.canEdit) return;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this._beforeSchedule = selected ? selected.id : '';
      const selectedMemberIds = selected ? selected.assigneeIds || [selected.assigneeId] : [];
      this.setData({ mode: 'schedule', loading: true, error: '', actionError: '', form: { taskId: selected ? selected.id : '', weekStart: selected ? selected.weekStart : sharing.monday(), reminderTime: selected ? selected.reminderLabel.slice(11) : '09:00', revision: selected ? selected.revision : 0 }, members: [], selectedMemberIds });
      try {
        const members = []; let offset = 0, result;
        do { result = await sharing.call('members', { offset }); members.push(...result.members); offset = result.nextOffset; } while (result.hasMore);
        if (!this._detached && epoch === this._epoch) this.setData({ members: members.map(member => ({ ...member, selected: selectedMemberIds.includes(member.id) })) });
      } catch (error) { if (!this._detached && epoch === this._epoch) this.setData({ error: error.message }); }
      finally { if (!this._detached && epoch === this._epoch) this.setData({ loading: false }); }
    },
    retry() { return this.data.mode === 'schedule' ? this.openSchedule() : this.data.mode === 'roster' ? this.openRoster() : this.load(); },
    cancelSchedule() { if (this.data.busy) return; this._taskId = this._beforeSchedule || ''; this.load(); },
    changeWeek(event) { this.setData({ 'form.weekStart': sharing.monday(event.detail.value) }); },
    changeMembers(event) {
      const ids = event.detail.value;
      if (ids.length > 2) { this.setData({ actionError: '每周请选择两名负责人。', members: this.data.members.map(member => ({ ...member, selected: this.data.selectedMemberIds.includes(member.id) })) }); return; }
      this.setData({ selectedMemberIds: ids, members: this.data.members.map(member => ({ ...member, selected: ids.includes(member.id) })) });
    },
    async saveSchedule() {
      if (this.data.busy || !this.data.form) return;
      if (this.data.selectedMemberIds.length !== 2) { this.setData({ actionError: '请选择两名值班负责人，共同完成一份分享。' }); return; }
      this.setData({ busy: true, actionError: '' });
      try {
        const result = await sharing.call('saveTask', { ...this.data.form, assigneeIds: this.data.selectedMemberIds });
        if (this._detached) return;
        this._taskId = result.task.id; this.renderDetail(result);
      } catch (error) { if (!this._detached) this.setData({ actionError: error.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async openRoster() {
      if (!this.data.canManage || this.data.busy) return;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ mode: 'roster', loading: true, roster: null, error: '', actionError: '' });
      try {
        const result = await sharing.call('roster');
        if (!this._detached && epoch === this._epoch) this.setData({ roster: result });
      } catch (error) { if (!this._detached && epoch === this._epoch) this.setData({ error: error.message }); }
      finally { if (!this._detached && epoch === this._epoch) this.setData({ loading: false }); }
    },
    async importRoster() {
      if (!this.data.canManage || this.data.busy || !this.data.roster) return;
      this.setData({ busy: true, actionError: '' });
      try {
        const result = await sharing.call('importRoster', { sha256: this.data.roster.sha256 });
        if (this._detached) return;
        const unbound = result.unboundNames.length ? '；待绑定成员：' + result.unboundNames.join('、') : '';
        this.setData({ importMessage: '已导入' + result.created + '周，跳过已有' + result.skipped + '周' + unbound });
        this._taskId = ''; await this.load();
      } catch (error) { if (!this._detached) this.setData({ actionError: error.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    changeTitle(event) { this._dirty = true; this._requestId = null; this.setData({ title: event.detail.value }); },
    changeNote(event) { this._dirty = true; this._requestId = null; this.setData({ note: event.detail.value }); },
    changeComment(event) { this.setData({ comment: event.detail.value }); },
    async changeArchive() {
      const selected = this.data.selected;
      if (this.data.busy || !selected || !(selected.canArchive || selected.canRestore)) return;
      const archived = !selected.archived;
      const choice = await wx.showModal({ title: archived ? '归档此任务？' : '恢复跟进？',
        content: archived ? '保留未完成记录，从首页待办和值班安排默认列表移除，并停止提醒。以后可以在已归档中恢复。' : '任务将重新显示在待办和值班安排中，可以继续安排补交。',
        confirmText: archived ? '归档' : '恢复跟进' });
      if (!choice.confirm || this._detached) return;
      this.setData({ busy: true, actionError: '' });
      try {
        const result = await sharing.call('setArchived', { taskId: selected.id, revision: selected.revision, archived });
        if (this._detached) return;
        this.renderDetail(result); wx.showToast({ title: archived ? '已归档' : '已恢复跟进', icon: 'success' });
      } catch (error) { if (!this._detached) this.setData({ actionError: error.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async chooseFiles() {
      if (this.data.busy || !this.data.selected || !this.data.selected.canUpload || this.data.files.length >= 5) return;
      this.setData({ busy: true, actionError: '' });
      try {
        const chosen = await wx.chooseMessageFile({ count: 5 - this.data.files.length, type: 'file', extension: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'] });
        for (const file of chosen.tempFiles) {
          if (file.size > 20 * 1024 * 1024 || this.data.files.reduce((sum, row) => sum + row.size, file.size) > 50 * 1024 * 1024) throw new Error('单个文件不超过20MB，合计不超过50MB。');
          const uploaded = await sharing.upload(file, this.data.selected.id);
          if (this._detached) return;
          this._dirty = true; this._requestId = null;
          this.setData({ files: this.data.files.concat(uploaded) });
        }
      } catch (error) { if (!this._detached && !/cancel/.test(error.errMsg || '')) this.setData({ actionError: error.message || '文件上传失败，请重试。' }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    removeFile(event) { if (!this.data.busy) { this._dirty = true; this._requestId = null; this.setData({ files: this.data.files.filter(file => file.id !== event.currentTarget.dataset.id) }); } },
    async submit() {
      if (this.data.busy || !this.data.selected || !this.data.selected.canUpload) return;
      if (!this.data.title.trim() || !this.data.cover || !this.data.files.length) { this.setData({ actionError: '请填写分享主题、上传封面和分享文件。' }); return; }
      this._requestId = this._requestId || sharing.newId();
      this.setData({ busy: true, actionError: '' });
      try {
        const result = await sharing.call('submit', { taskId: this.data.selected.id, revision: this.data.selected.revision, requestId: this._requestId,
          title: this.data.title, note: this.data.note, coverFileId: this.data.cover.id, fileIds: this.data.files.map(file => file.id) });
        if (this._detached) return;
        this._dirty = false; this._requestId = null; this.renderDetail(result);
        wx.showToast({ title: '已提交审批', icon: 'success' });
      } catch (error) { if (!this._detached) this.setData({ actionError: error.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async review(event) {
      const decision = event.currentTarget.dataset.decision;
      if (this.data.busy || !this.data.selected || !this.data.selected.canReview) return;
      if (decision === 'rejected' && !this.data.comment.trim()) { this.setData({ actionError: '请填写驳回原因。' }); return; }
      this.setData({ busy: true, actionError: '' });
      try {
        const selected = this.data.selected;
        const result = await sharing.call('review', { taskId: selected.id, revision: selected.revision, version: selected.submission.version, decision, comment: this.data.comment });
        if (this._detached) return;
        this.renderDetail(result); wx.showToast({ title: decision === 'approved' ? '审批通过' : '已驳回', icon: 'success' });
      } catch (error) { if (!this._detached) this.setData({ actionError: error.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async openFile(event) {
      if (this.data.downloadId || this.data.busy || !this.data.selected || !this.data.selected.submission) return;
      const file = this.data.selected.submission.files.find(row => row.id === event.currentTarget.dataset.id);
      if (!file) return;
      this.setData({ downloadId: file.id, progress: 0, actionError: '' });
      try {
        const path = await sharing.download(this.data.selected.id, file, progress => { if (!this._detached) this.setData({ progress }); });
        this._localFiles = (this._localFiles || []).concat(path);
        if (this._detached) { await sharing.removeLocal(path); return; }
        await wx.openDocument({ filePath: path, fileType: file.ext, showMenu: true });
      } catch (error) { if (!this._detached) this.setData({ actionError: error.message || '文件打开失败，请重试。' }); }
      finally { if (!this._detached) this.setData({ downloadId: '' }); }
    }
  }
});
