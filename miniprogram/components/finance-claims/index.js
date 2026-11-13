const finance = require('../../services/finance');
const access = require('../../services/access');
const today = () => finance.dateLabel(Date.now()).slice(0, 10);
const emptyForm = () => ({ category: '', amount: '', description: '', ownerId: '', ownerName: '', files: [], kindIndex: 0,
  invoiceDate: '', confirmed: false, transportMode: '', origin: '', destination: '', wuhan: false, school: false, nonHub: false });
const transportModes = [{ id: '', label: '选择乘车方式' }, { id: 'ride', label: '网约车' }, { id: 'taxi', label: '巡游出租车（的士）' }];
const transportChecks = [{ id: 'wuhan', label: '行程在武汉市内' }, { id: 'school', label: '起点或终点为学校' },
  { id: 'nonHub', label: '目的地不是高铁站、车站或机场' }];

Component({
  properties: { initialClaim: { type: String, value: '' } },
  data: { section: 'mine', mode: 'list', studentOnly: true, current: {}, stages: [], categories: [], categoryChoices: [], categoryIndex: 0, fileKinds: finance.fileKinds,
    loading: true, busy: false, error: '', claims: [], groups: [], inboxGroups: [], queue: 'review', week: '', today: '', deskPickerEnd: '', deskWeekLabel: '', deskWeekRange: '', hasMore: false,
    selection: [], selectedAmount: '0.00', reportCount: 0, detail: null, steps: [], progressStage: 0, form: emptyForm(), members: [],
    reason: '', returning: false, feishuEnabled: false, syncLabel: '', syncErrors: 0, progress: null,
    studentRules: [], studentFileKinds: {}, materialChoices: [], formRule: null, mealWarning: false, transportModes, transportChecks },
  lifetimes: {
    attached() {
      this._visible = true;
      this.setData({ today: today(), deskPickerEnd: finance.dateLabel(Date.now() + 7 * 86400000).slice(0, 10) });
      this.startLive();
      this.initialize();
    },
    detached() { this._detached = true; this.stopLive(); this.clearLocal(); }
  },
  pageLifetimes: {
    show() { this._visible = true; this.startLive(); if (this._initialized) this.refresh(); },
    hide() { this._visible = false; this.stopLive(); }
  },
  methods: {
    startLive() {
      if (!this._unsubscribe) this._unsubscribe = access.subscribeChanges('messages', () => this.refresh());
      if (!this._membersChanged) this._membersChanged = access.subscribeChanges('members', () => this.checkIdentity());
      this.checkIdentity();
    },
    checkIdentity() {
      const scope = access.identityScope();
      if (this._detached || scope === this._identityScope) return;
      const previous = this._identityScope;
      this._identityScope = scope;
      if (previous === undefined) return;
      this._epoch = (this._epoch || 0) + 1;
      this._session = (this._session || 0) + 1;
      this._studentUploads?.clear();
      this.setData({ busy: false, current: {}, studentOnly: true, studentRules: [], studentFileKinds: {}, detail: null, claims: [], groups: [], inboxGroups: [], form: emptyForm(), mode: 'list', section: 'mine' });
      this.clearLocal();
      this.initialize();
    },
    stopLive() {
      if (this._unsubscribe) this._unsubscribe();
      if (this._membersChanged) this._membersChanged();
      this._unsubscribe = this._membersChanged = null;
    },
    async clearLocal() {
      const files = this._local || [];
      this._local = [];
      for (const path of files) await finance.removeDownload(path);
    },
    async initialize() {
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, error: '' });
      try {
        const data = await finance.call('list');
        if (this._detached || this._epoch !== epoch) return;
        this._initialized = true;
        this._offset = data.claims.length;
        const studentFileKinds = data.studentFileKinds || {};
        const section = data.current.financeDesk ? 'desk' : 'mine';
        this.setData({ section, current: data.current, studentOnly: data.studentOnly !== false, stages: data.stages, categories: data.categories, week: data.week,
          studentRules: data.studentRules || [], studentFileKinds, categoryChoices: ['全部类别', ...data.categories], categoryIndex: 0,
          feishuEnabled: data.feishuEnabled, claims: data.claims.map(row => finance.claimView(row, studentFileKinds)), hasMore: data.hasMore, loading: false });
        if (this.properties.initialClaim && !this._openedInitial) {
          this._openedInitial = true;
          await this.loadClaim(this.properties.initialClaim);
        } else if (section === 'desk') await this.loadList();
      } catch (error) { if (!this._detached && this._epoch === epoch) this.setData({ loading: false, error: error.message }); }
    },
    async refresh() {
      if (!this._visible || this._detached || this.data.busy || this.data.loading || this.data.mode === 'form' || this.data.returning) return;
      if (!this._initialized) return this.initialize();
      if (this.data.mode === 'detail' && this._claimId) return this.loadClaim(this._claimId);
      return this.loadList();
    },
    retry() { return this.refresh(); },
    async loadList(more = false) {
      const { section, week, queue, studentOnly, categories, categoryIndex } = this.data;
      if (section === 'desk') return this.loadDesk(week, more);
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, error: '' });
      try {
        const result = section === 'week' ? await finance.call('weekView', { week }) : await finance.call('list', {
          scope: section, queue, category: studentOnly && categoryIndex ? categories[categoryIndex - 1] : '', offset: more ? this._offset : 0
        });
        if (this._detached || this._epoch !== epoch) return;
        const claims = (more ? this.data.claims : []).concat(result.claims.map(row => finance.claimView(row, this.data.studentFileKinds)));
        this._offset = (more ? this._offset : 0) + result.claims.length;
        const selection = this.data.selection.filter(id => claims.some(claim => claim.id === id));
        const selected = new Set(selection);
        const rows = claims.map(claim => ({ ...claim, checked: selected.has(claim.id) }));
        this.setData({ claims: rows, groups: section === 'week' ? finance.groups(rows) : [], hasMore: !!result.hasMore,
          ...(studentOnly ? { studentRules: result.studentRules || [], studentFileKinds: result.studentFileKinds || {} } : {}),
          inboxGroups: result.inbox ? finance.groups(result.inbox.map(row => finance.claimView(row))) : [], hasMoreInbox: !!result.hasMoreInbox,
          selection, ...this.totals(rows, selected), syncLabel: result.lastSyncMs ? finance.dateLabel(result.lastSyncMs) : '',
          syncErrors: result.syncErrors || 0, pendingSync: result.pendingSync || 0 });
      } catch (error) {
        if (!this._detached && this._epoch === epoch) this.setData({ error: error.message, claims: [], groups: [], inboxGroups: [], hasMore: false });
      } finally { if (!this._detached && this._epoch === epoch) this.setData({ loading: false }); }
    },
    async loadDesk(week, more) {
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, error: '' });
      try {
        const { claims: page, nextCursor, weekInfo } = await finance.call('deskWeek', { week, cursor: more ? this._deskCursor : undefined });
        if (this._detached || this._epoch !== epoch) return;
        this._deskCursor = nextCursor;
        const claims = (more ? this.data.claims : []).concat(page.map(row => finance.claimView(row, this.data.studentFileKinds)));
        const groups = finance.groups(claims);
        this.setData({ claims, groups, hasMore: !!nextCursor, deskWeekLabel: weekInfo?.label || '提交周',
          deskWeekRange: weekInfo ? weekInfo.start + ' 至 ' + weekInfo.end : week + ' 起',
          submittedCount: claims.filter(row => row.invoiceCount > 0).length, paidCount: claims.filter(row => row.stage === 5).length });
      } catch (error) {
        if (!this._detached && this._epoch === epoch) this.setData({ error: error.message,
          ...(more ? {} : { claims: [], groups: [], hasMore: false, deskWeekLabel: '提交周', deskWeekRange: week + ' 起', submittedCount: 0, paidCount: 0 }) });
      } finally { if (!this._detached && this._epoch === epoch) this.setData({ loading: false }); }
    },
    totals(claims, selected) {
      const selectedClaims = claims.filter(row => selected.has(row.id));
      return { reportCount: selected.size, selectedAmount: finance.money(selectedClaims.reduce((sum, row) => sum + row.cents, 0)),
        reportGroups: finance.groups(selectedClaims) };
    },
    changeSection(event) {
      const section = event.currentTarget.dataset.section;
      if (this.data.busy || !['mine', 'desk', 'queue', 'week'].includes(section) ||
          (this.data.studentOnly && section !== 'mine' && section !== 'desk') || (section === 'desk' && !this.data.current.financeDesk) ||
          (section === 'queue' && !this.data.current.finance) || (section === 'week' && !this.data.current.finance && !this.data.current.reviewer)) return;
      this.setData({ section, mode: 'list', detail: null, selection: [], returning: false });
      this.loadList();
    },
    changeStudentCategory(event) {
      const categoryIndex = Number(event.detail.value);
      if (!this.data.studentOnly || !Number.isInteger(categoryIndex) || categoryIndex < 0 ||
          categoryIndex >= this.data.categoryChoices.length || categoryIndex === this.data.categoryIndex) return;
      this.setData({ categoryIndex });
      this.loadList();
    },
    changeQueue(event) {
      if (this.data.busy) return;
      this.setData({ queue: event.currentTarget.dataset.queue, selection: [] });
      this.loadList();
    },
    changeWeek(event) {
      if (this.data.busy) return;
      this.setData({ week: finance.monday(event.detail.value) });
      if (this.data.section === 'week' || this.data.section === 'desk') this.loadList();
    },
    more() { if (!this.data.loading && this.data.hasMore) this.loadList(true); },
    selectClaims(event) {
      const selection = event.detail.value.slice(0, 20), selected = new Set(selection);
      const claims = this.data.claims.map(row => ({ ...row, checked: selected.has(row.id) }));
      this.setData({ claims, selection, ...this.totals(claims, selected) });
      if (event.detail.value.length > 20) wx.showToast({ title: '每次最多报送20笔', icon: 'none' });
    },
    async sendWeek() {
      if (this.data.busy || !this.data.selection.length) return;
      const { confirm } = await wx.showModal({ title: '确认本周报送',
        content: this.data.week + ' 当周，共 ' + this.data.reportCount + ' 笔，合计 ¥' + this.data.selectedAmount + '。' });
      if (!confirm) return;
      await this.perform(async active => {
        await finance.call('sendWeek', { week: this.data.week, ids: this.data.selection });
        if (!active()) return;
        this.setData({ section: 'week', selection: [] });
        await this.loadList();
      });
    },
    async syncWeek() {
      await this.perform(async active => {
        let offset = 0, failed = 0, more;
        do {
          const data = await finance.call('syncWeek', { week: this.data.week, offset });
          if (!active()) return;
          offset = data.nextOffset;
          failed += data.failed;
          more = data.hasMore;
        } while (more);
        await this.loadList();
        if (!active()) return;
        wx.showToast({ title: failed ? failed + ' 笔同步失败' : '同步完成', icon: failed ? 'none' : 'success' });
      });
    },
    openClaim(event) { if (!this.data.busy) this.loadClaim(event.currentTarget.dataset.id); },
    async loadClaim(id) {
      this._claimId = id;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, error: '', mode: 'detail' });
      try {
        const result = await finance.call('get', { claimId: id });
        if (!this._detached && epoch === this._epoch) this.renderClaim(result.claim);
      } catch (error) {
        if (!this._detached && epoch === this._epoch) this.setData({ error: error.message, detail: null });
      } finally { if (!this._detached && epoch === this._epoch) this.setData({ loading: false }); }
    },
    renderClaim(row) {
      this._claimId = row.id;
      const detail = finance.claimView(row, this.data.studentFileKinds);
      const steps = this.data.stages.slice(1).map((label, index) => ({ label, done: row.stage >= index + 1, current: row.stage === index + 1 }));
      this.setData({ mode: 'detail', detail, steps, progressStage: row.stage, reason: '', returning: false,
        canSupplement: !this.data.studentOnly && row.reviewState === 'needs' && (this.data.current.id === row.ownerId || this.data.current.finance) });
    },
    back() {
      if (this.data.busy) return;
      if (this.data.mode === 'form' && this.data.studentOnly) {
        this._studentUploads.clear();
        this.setData({ form: emptyForm() });
      }
      if (this.data.mode === 'form' && this.data.detail) { this.renderClaim(this.data.detail); return; }
      this.setData({ mode: 'list', detail: null, error: '', returning: false });
      this.loadList();
    },
    async startForm(event) {
      if (this.data.busy || !this.data.current.id) return;
      const kind = event.currentTarget.dataset.kind || 'mine';
      if (this.data.studentOnly) {
        if (kind !== 'mine' || !this.data.studentRules.length) return;
        this._requestId = finance.newId();
        this._studentUploads = new Map();
        this.setData({ mode: 'form', formKind: kind, detail: null, error: '', form: { ...emptyForm(), invoiceDate: today() },
          formCategoryChoices: ['选择类别', ...this.data.categories], formCategoryIndex: 0,
          transportIndex: 0 });
        this.updateMaterialChoices();
        return;
      }
      const detail = kind === 'supplement' ? this.data.detail : null;
      this._requestId = finance.newId();
      this.setData({ mode: 'form', formKind: kind, detail, error: '', members: [], removeIds: [], previousFiles: detail ? detail.files : [], form: { ...emptyForm(),
        category: detail ? detail.category : '', amount: detail ? detail.amount : '', ownerId: detail ? detail.ownerId : '' } });
      if (kind === 'proxy') await this.perform(async active => {
        let offset = 0, more;
        const members = [];
        do {
          const response = await access.directory(offset);
          if (!active()) return;
          members.push(...response.members.filter(member => member.name !== '-').map(member => ({ ...member, label: member.name + ' · ' + member.id.slice(-6) })));
          offset = response.nextOffset;
          more = response.hasMore;
        } while (more);
        this.setData({ members });
      });
    },
    changeOwner(event) {
      const member = this.data.members[Number(event.detail.value)];
      if (member) this.setData({ 'form.ownerId': member.id, 'form.ownerName': member.label });
    },
    changeCategory(event) {
      const index = Number(event.detail.value);
      const category = this.data.categories[index - (this.data.studentOnly ? 1 : 0)];
      if (this.data.form.category === (category || '')) return;
      if (!this.data.studentOnly) { this.setData({ 'form.category': category }); return; }
      if (!category && index !== 0) return;
      const { form } = this.data;
      this.setData({ formCategoryIndex: index, transportIndex: 0, form: { ...emptyForm(), category: category || '', amount: form.amount, description: form.description, invoiceDate: form.invoiceDate,
        files: form.files.filter(file => file.kind === 'invoice') }, error: '' });
      this.updateMaterialChoices();
    },
    updateMaterialChoices() {
      const { studentRules, studentFileKinds, form } = this.data;
      const formRule = studentRules.find(rule => rule.category === form.category) || null;
      const cents = finance.parseAmount(form.amount);
      const high = formRule?.threshold && cents >= formRule.threshold;
      const required = ['invoice', ...(high ? formRule.above : formRule?.required || [])];
      if (form.transportMode === 'ride') required.push('trip');
      const optional = high ? [] : formRule?.optional || [];
      const materialChoices = [...new Set(required.concat(optional))].map(id => ({ id, label: studentFileKinds[id], required: required.includes(id),
        files: form.files.filter(file => file.kind === id) }));
      this.setData({ formRule, materialChoices, mealWarning: form.category === '餐饮票' && cents > 200000 });
    },
    changeKind(event) { this.setData({ 'form.kindIndex': Number(event.detail.value) }); },
    inputAmount(event) {
      this.setData({ 'form.amount': event.detail.value });
      if (this.data.studentOnly) this.updateMaterialChoices();
    },
    inputDescription(event) { this.setData({ 'form.description': event.detail.value }); },
    inputStudentField(event) { this.setData({ ['form.' + event.currentTarget.dataset.field]: event.detail.value }); },
    changeTransport(event) {
      const transportIndex = Number(event.detail.value);
      const mode = transportModes[transportIndex];
      if (!mode || this.data.form.transportMode === mode.id) return;
      this.setData({ transportIndex, 'form.transportMode': mode.id, 'form.wuhan': false, 'form.school': false, 'form.nonHub': false });
      this.updateMaterialChoices();
    },
    confirmRule(event) { this.setData({ 'form.confirmed': event.detail.value.includes('confirmed') }); },
    confirmTransport(event) {
      const checked = event.detail.value;
      this.setData({ 'form.wuhan': checked.includes('wuhan'), 'form.school': checked.includes('school'), 'form.nonHub': checked.includes('nonHub') });
    },
    inputReason(event) { this.setData({ reason: event.detail.value }); },
    toggleReturn() { this.setData({ returning: !this.data.returning, error: '' }); },
    async addFile(event) {
      const { source, kind: studentKind } = event.currentTarget.dataset;
      const kind = this.data.studentOnly ? studentKind : this.data.fileKinds[this.data.form.kindIndex].id;
      const claimId = this.data.formKind === 'supplement' ? this.data.detail.id : '';
      await this.perform(async active => {
        let file;
        if (source === 'image') {
          const selection = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['original'] });
          const item = selection.tempFiles[0], info = await wx.getImageInfo({ src: item.tempFilePath });
          const ext = info.type === 'jpeg' ? 'jpg' : info.type;
          file = { path: item.tempFilePath, size: item.size, name: finance.fileLabel(kind) + '.' + ext };
        } else {
          const extension = this.data.studentOnly && kind === 'invoice' ? ['pdf'] : ['pdf', 'jpg', 'jpeg', 'png'];
          const selection = await wx.chooseMessageFile({ count: 1, type: 'file', extension });
          file = selection.tempFiles[0];
        }
        if (!file) return;
        if (!active()) return;
        if (this.data.studentOnly) {
          if (!/\.(pdf|jpe?g|png)$/i.test(file.name) || (kind === 'invoice' && !/\.pdf$/i.test(file.name))) throw new Error('请选择符合要求的文件格式。');
          if (file.size < 1 || file.size > 8 * 1024 * 1024) throw new Error('单份材料须大于 0 且不超过 8 MB。');
          const existing = kind === 'invoice' ? this.data.form.files.filter(item => item.kind !== kind) : this.data.form.files;
          this.setData({ 'form.files': existing.concat({ ...file, id: finance.newId(), kind }) });
          this.updateMaterialChoices();
          return;
        }
        const result = await finance.upload(file, kind, claimId);
        if (active()) this.setData({ 'form.files': this.data.form.files.concat({ ...result, kindLabel: finance.fileLabel(kind) }) });
      });
    },
    removeFile(event) {
      if (this.data.busy) return;
      this.setData({ 'form.files': this.data.form.files.filter(file => file.id !== event.currentTarget.dataset.id) });
      if (this.data.studentOnly) this.updateMaterialChoices();
    },
    togglePreviousFile(event) {
      if (this.data.busy) return;
      const id = event.currentTarget.dataset.id, remove = new Set(this.data.removeIds);
      if (remove.has(id)) remove.delete(id);
      else remove.add(id);
      const previousFiles = this.data.detail.files.map(file => ({ ...file, removed: remove.has(file.id) }));
      this.setData({ removeIds: Array.from(remove), previousFiles });
    },
    async submit() {
      const { form, formKind, detail, removeIds } = this.data;
      const fileIds = form.files.map(file => file.id);
      await this.perform(async active => {
        let result;
        if (this.data.studentOnly) result = await this.submitStudent(form, active);
        else if (formKind === 'supplement') result = await finance.call('supplement', { claimId: detail.id, revision: detail.revision, requestId: this._requestId, fileIds, removeIds });
        else {
          if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(form.amount.trim()) || !form.category || (formKind === 'proxy' && !form.ownerId)) throw new Error('请填写报销人、分类及有效金额。');
          const [whole, fraction = ''] = form.amount.trim().split('.');
          const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
          const required = ['invoice'];
          if (cents >= 50000) required.push('payment', 'purchase');
          if (form.category === '打车') required.push('trip');
          const missing = required.filter(kind => !form.files.some(file => file.kind === kind));
          if (missing.length) throw new Error('请补齐：' + missing.map(finance.fileLabel).join('、'));
          result = await finance.call('submit', { ownerId: form.ownerId, category: form.category, description: form.description,
            cents, requestId: this._requestId, fileIds });
        }
        if (active() && result) {
          if (this.data.studentOnly) {
            this._studentUploads.clear();
            this.setData({ form: emptyForm(), categoryIndex: 0 });
          }
          this.renderClaim(result.claim);
        }
      });
    },
    async submitStudent(form, active) {
      const { formRule, materialChoices } = this.data;
      const { category, invoiceDate, description, confirmed, transportMode, origin, destination, wuhan, school, nonHub } = form;
      const cents = finance.parseAmount(form.amount);
      if (!formRule || cents < 1 || cents > 100000000 || !invoiceDate || !description.trim())
        throw new Error('请填写报销类别、开票日期、用途和有效的发票金额。');
      if (formRule.confirmation && !confirmed) throw new Error('请确认：' + formRule.confirmation);
      if (category === '交通费') {
        if (!transportMode || !origin.trim() || !destination.trim()) throw new Error('请选择乘车方式并填写出发地和目的地。');
        if (transportMode === 'ride' && (!wuhan || !school || !nonHub || /高铁站|火车站|铁路站|机场|车站/.test(destination)))
          throw new Error('请确认网约车行程符合要求。');
      }
      const missing = materialChoices.filter(item => item.required && !item.files.length);
      if (missing.length) throw new Error('请补齐：' + missing.map(item => item.label).join('、'));
      const files = materialChoices.flatMap(item => item.files.map((file, index) => ({ ...file, ordinal: index + 1 })));
      if (files.length > 12 || files.reduce((size, file) => size + file.size, 0) > 16 * 1024 * 1024)
        throw new Error('每笔申请最多 12 份材料，合计不超过 16 MB。');
      const uploads = this._studentUploads, requestId = this._requestId, fileIds = [];
      for (const file of files) {
        const key = [file.id, category, cents, file.ordinal].join(':');
        if (!uploads.has(key)) uploads.set(key, (await finance.upload(file, file.kind, '', { category, cents, ordinal: file.ordinal })).id);
        if (!active()) return;
        fileIds.push(uploads.get(key));
      }
      return finance.call('submit', { category, invoiceDate, description, confirmed, transportMode, origin, destination,
        wuhan, school, nonHub, cents, requestId, fileIds });
    },
    async review(event) {
      const pass = event.currentTarget.dataset.pass === 'yes';
      const { detail, reason } = this.data;
      await this.perform(async active => {
        const result = await finance.call('review', { claimId: detail.id, revision: detail.revision, pass, reason });
        if (active()) this.renderClaim(result.claim);
      });
    },
    async advance(event) {
      if (this.data.busy) return;
      const stage = Number(event.currentTarget.dataset.stage), detail = this.data.detail;
      if (stage === 5) {
        const result = await wx.showModal({ title: '确认到账', content: '请在同学确认收到款项后登记。' });
        if (!result.confirm) return;
      }
      await this.perform(async active => {
        const result = await finance.call('move', { claimId: detail.id, revision: detail.revision, stage, received: stage === 5 });
        if (active()) this.renderClaim(result.claim);
      });
    },
    selectProgress(event) {
      const stage = Number(event.detail.value);
      if (!this.data.busy && Number.isInteger(stage) && this.data.stages[stage]) this.setData({ progressStage: stage });
    },
    async saveProgress() {
      const { current, section, detail, progressStage: stage, stages } = this.data;
      if (section !== 'desk' || !current.financeDesk || !detail?.progressVersion || stage === detail.stage || !stages[stage]) return;
      await this.perform(async active => {
        const received = stage === stages.length - 1;
        const { confirm } = await wx.showModal({
          title: received ? '确认已到账' : '确认更新报销进度',
          content: received ? '同学确认收到款项后，再登记为「已到账」。' : '将这笔报销从「' + detail.label + '」改为「' + stages[stage] + '」。',
          confirmText: received ? '已确认' : '保存'
        });
        if (!confirm || !active()) return;
        const result = await finance.call('deskProgress', { claimId: detail.id, stage, version: detail.progressVersion, received });
        if (active()) {
          this.renderClaim(result.claim);
          wx.showToast({ title: '进度已更新', icon: 'success' });
        }
      });
    },
    async previewFile(event) {
      const detail = this.data.detail;
      const file = detail.files.find(item => item.id === event.currentTarget.dataset.id);
      if (!file) return;
      await this.perform(async active => {
        const path = await this.download(file, detail.id, active);
        if (!path) return;
        if (file.ext === 'pdf') await wx.openDocument({ filePath: path, fileType: 'pdf' });
        else await wx.previewImage({ urls: [path], current: path });
      });
    },
    async exportWeek(event) {
      const { section, week } = this.data;
      const ownerId = event.currentTarget.dataset.owner;
      await this.perform(async active => {
        this.setData({ progress: 0 });
        const { file } = await finance.call(section === 'desk' ? 'deskArchive' : 'openArchive', { week, ...(ownerId ? { ownerId } : {}) });
        if (!active()) return;
        const path = await this.download(file, '', active);
        if (!path) return;
        if (typeof wx.saveFileToDisk === 'function') await wx.saveFileToDisk({ filePath: path });
        else if (typeof wx.shareFileMessage === 'function') await wx.shareFileMessage({ filePath: path, fileName: file.name });
        else throw new Error('请使用支持文件导出的新版微信。');
      });
    },
    async download(file, claimId, active) {
      await this.clearLocal();
      if (!active()) return '';
      const path = await finance.download(file, claimId, progress => {
        if (active()) this.setData({ progress });
      }, active);
      if (!active()) { await finance.removeDownload(path); return ''; }
      this._local = (this._local || []).concat(path);
      return path;
    },
    async perform(action) {
      if (this.data.busy || this._detached) return;
      const session = this._session;
      const active = () => !this._detached && this._session === session;
      this.setData({ busy: true, error: '', progress: null });
      try { await action(active); }
      catch (error) {
        if (active() && !/cancel/i.test(error.errMsg || error.message || '')) {
          this.setData({ error: error.message || error.errMsg || '操作失败，请重试。' });
        }
      } finally { if (active()) this.setData({ busy: false, progress: null }); }
    }
  }
});
