const access = require('../../services/access');
const ID = /^lv_[a-f0-9]{32}$/;
const ROOT = '/pages/leave/index';
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const requestKey = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 14).padEnd(12, '0');

Page(require('../../utils/member-page')({
  data: { mode: 'list', loading: true, saving: false, error: '', actionError: '', rows: [], hasMore: false, detail: null,
    types: ['事假', '病假', '其他'], reviewers: [], reviewerIndex: -1, dialog: '', note: '',
    form: { leaveType: '事假', allDay: true, startDate: '', endDate: '', startTime: '09:00', endTime: '18:00', reason: '' } },
  onLoad(options = {}) {
    const mode = options.id ? 'detail' : options.mode === 'new' ? 'new' : 'list';
    this._id = options.id || '';
    this._key = requestKey();
    this.setData({ mode, form: { ...this.data.form, startDate: today(), endDate: today() } });
    wx.setNavigationBarTitle({ title: mode === 'detail' ? '请假详情' : mode === 'new' ? '发起请假' : '请假' });
  },
  onShow() {
    this._visible = true;
    this._unsubscribe = access.subscribeChanges('approvals', () => { if (!this.data.saving && this.data.mode !== 'new') this.load(); });
    this._unsubscribeMembers = access.subscribeChanges('members', () => {
      if (this.data.mode === 'detail') this.setData({ detail: null, dialog: '' });
      this.load();
    });
    return this.load();
  },
  onHide() {
    this._visible = false;
    this._epoch = (this._epoch || 0) + 1;
    if (this._unsubscribe) this._unsubscribe();
    if (this._unsubscribeMembers) this._unsubscribeMembers();
  },
  onUnload() { this._unloaded = true; this.onHide(); },
  async load(more = false) {
    if (!this._visible || this._unloaded || more === true && (this.data.loading || !this.data.hasMore)) return;
    const epoch = this._epoch = (this._epoch || 0) + 1, mode = this.data.mode;
    const current = () => this._visible && this._epoch === epoch;
    this.setData({ loading: true, error: '' });
    try {
      if (mode === 'new') {
        const { reviewers } = await access.leave({ action: 'leaveReviewers' });
        if (!current()) return;
        const old = this.data.reviewers[this.data.reviewerIndex];
        const found = old ? reviewers.findIndex(row => row.id === old.id) : -1;
        this.setData({ reviewers, reviewerIndex: found >= 0 ? found : reviewers.length === 1 ? 0 : -1 });
      } else if (mode === 'detail') {
        if (!ID.test(this._id)) throw new Error('请假单地址不正确。');
        const { request } = await access.leave({ action: 'leaveDetail', id: this._id });
        if (current()) this.setData({ detail: request,
          ...(this.data.detail && this.data.detail.revision !== request.revision ? { dialog: '', actionError: '' } : {}) });
      } else {
        const offset = more === true ? this._offset : 0;
        const result = await access.leave({ action: 'leaveList', offset });
        if (!current()) return;
        if (!Array.isArray(result.requests) || !Number.isSafeInteger(result.nextOffset) || result.nextOffset < offset ||
          result.hasMore && result.nextOffset === offset) throw new Error('请假记录读取失败，请重试。');
        this._offset = result.nextOffset;
        const rows = new Map((more === true ? this.data.rows : []).map(row => [row.id, row]));
        result.requests.forEach(row => rows.set(row.id, row));
        this.setData({ rows: Array.from(rows.values()), hasMore: result.hasMore });
      }
    } catch (error) {
      if (current()) this.setData({ error: error.message || '请假服务暂时不可用。', ...(mode === 'detail' ? { detail: null, dialog: '' } : {}) });
    } finally { if (current()) this.setData({ loading: false }); }
  },
  loadMore() { return this.load(true); },
  newRequest() { wx.navigateTo({ url: ROOT + '?mode=new' }); },
  openRequest(event) {
    const id = event.currentTarget.dataset.id;
    if (ID.test(id)) wx.navigateTo({ url: ROOT + '?id=' + id });
  },
  updateForm(patch) {
    if (this.data.saving) return;
    this._key = requestKey();
    this.setData({ form: { ...this.data.form, ...patch }, actionError: '' });
  },
  changeType(event) { this.updateForm({ leaveType: this.data.types[Number(event.detail.value)] }); },
  changeDuration(event) { this.updateForm({ allDay: event.currentTarget.dataset.mode === 'day' }); },
  changeField(event) {
    const field = event.currentTarget.dataset.field, value = event.detail.value;
    if (['startDate', 'endDate', 'startTime', 'endTime', 'reason'].includes(field)) {
      this.updateForm({ [field]: value, ...(field === 'startDate' && value > this.data.form.endDate ? { endDate: value } : {}) });
    }
  },
  changeReviewer(event) {
    if (this.data.saving) return;
    this._key = requestKey();
    this.setData({ reviewerIndex: Number(event.detail.value), actionError: '' });
  },
  async submit() {
    if (this.data.mode !== 'new' || this.data.loading || this.data.saving) return;
    const reviewer = this.data.reviewers[this.data.reviewerIndex];
    if (!reviewer || !this.data.form.reason.trim()) return this.setData({ actionError: reviewer ? '请填写简要事由。' : '请选择一位领导审批。' });
    this.setData({ saving: true, actionError: '' });
    try {
      const result = await access.changeLeave({ ...this.data.form, reviewerId: reviewer.id, requestId: this._key, action: 'leaveSubmit' });
      if (!this._unloaded) {
        this._id = result.id;
        this.setData({ mode: 'detail', form: { ...this.data.form, reason: '' }, detail: null });
        wx.setNavigationBarTitle({ title: '请假详情' });
        await this.load();
      }
    } catch (error) {
      if (!this._unloaded) {
        this.setData({ actionError: error.message });
        if (error.code === 'NO_REVIEWER') this.load();
      }
    } finally { if (!this._unloaded) this.setData({ saving: false }); }
  },
  async openAction(event) {
    const action = event.currentTarget.dataset.action, item = this.data.detail;
    if (!item || this.data.saving || this.data.loading) return;
    const sameDetail = () => this._visible && this.data.detail && this.data.detail.id === item.id && this.data.detail.revision === item.revision;
    if (action === 'approve' && item.canReview && item.canApprove || action === 'withdraw' && item.canWithdraw) {
      return wx.showModal({ title: action === 'approve' ? item.approveLabel : item.withdrawalLabel,
        content: '确认执行此操作？', success: result => { if (result.confirm && sameDetail()) this.change(action); } });
    }
    if (action === 'reject' && item.canReview || action === 'cancel' && item.canCancel && !item.canReassign) {
      this.setData({ dialog: action, note: '', actionError: '' });
    } else if (action === 'reassign' && item.canReassign) {
      this.setData({ saving: true, actionError: '' });
      try {
        const { reviewers } = await access.leave({ action: 'leaveReviewers' });
        if (sameDetail()) this.setData({ dialog: action, reviewers, reviewerIndex: reviewers.length === 1 ? 0 : -1 });
      } catch (error) { if (!this._unloaded) this.setData({ actionError: error.message }); }
      finally { if (!this._unloaded) this.setData({ saving: false }); }
    }
  },
  updateNote(event) { this.setData({ note: event.detail.value }); },
  closeAction() { if (!this.data.saving) this.setData({ dialog: '', note: '', actionError: '' }); },
  confirmAction() { return this.change(this.data.dialog); },
  async change(action) {
    const item = this.data.detail;
    if (!item || this.data.saving || this.data.loading) return;
    const review = (action === 'approve' || action === 'reject') && item.canReview && (action !== 'approve' || item.canApprove);
    const operation = review ? 'leaveReview' : action === 'withdraw' && item.canWithdraw ? 'leaveWithdraw' :
      action === 'cancel' && item.canCancel && !item.canReassign ? 'leaveCancel' : action === 'reassign' && item.canReassign ? 'leaveReassign' : '';
    if (!operation) return;
    const note = this.data.note.trim(), reviewer = this.data.reviewers[this.data.reviewerIndex];
    if ((action === 'reject' || action === 'cancel') && !note) return this.setData({ actionError: '请填写原因。' });
    if (action === 'reassign' && !reviewer) return this.setData({ actionError: '请选择一位领导审批。' });
    this.setData({ saving: true, actionError: '' });
    try {
      await access.changeLeave({ action: operation, id: item.id, revision: item.revision,
        ...(review ? { decision: action } : {}), ...(action === 'reject' || action === 'cancel' ? { note } : {}),
        ...(action === 'reassign' ? { reviewerId: reviewer.id } : {}) });
      if (!this._unloaded) { this.setData({ dialog: '', note: '' }); await this.load(); }
    } catch (error) {
      if (!this._unloaded) {
        this.setData({ actionError: error.message });
        if (['CONFLICT', 'NO_REVIEWER', 'FORBIDDEN', 'INVALID_STATE'].includes(error.code)) await this.load();
      }
    } finally { if (!this._unloaded) this.setData({ saving: false }); }
  }
}));
