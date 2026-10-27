const equipment = require('../../services/equipment');
const { display } = require('../../utils/equipment');

function value(value) { return value === undefined || value === null || value === '' ? '-' : value; }

Page({
  data: { loading: true, error: '', record: null, groups: [] },
  onLoad(options) {
    this._id = options.id || '';
    this.loadRecord();
  },
  onUnload() { this._unloaded = true; },
  async loadRecord() {
    this.setData({ loading: true, error: '' });
    try {
      const raw = await equipment.getDetail(this._id);
      if (this._unloaded) return;
      this.setData({ record: display(raw), groups: [
        { title: '设备信息', rows: [
          { label: '设备名称', value: value(raw.name) },
          { label: '设备编号', value: value(raw.equipmentNumber), copy: !!raw.equipmentNumber },
          { label: '设备型号', value: value(raw.model) },
          { label: '台账流水号', value: value(raw.inventoryNumber), copy: !!raw.inventoryNumber }
        ] },
        { title: '使用与保管', rows: [
          { label: '使用情况', value: value(raw.status) },
          { label: '使用人', value: value(raw.user) },
          { label: '设备位置', value: value(raw.location) },
          { label: '责任人', value: value(raw.custodian) }
        ] },
        { title: '登记与盘点', rows: [
          { label: '登记日期', value: value(raw.registeredDate) },
          { label: '盘点日期', value: value(raw.checkedDate) }
        ] }
      ] });
    } catch (error) {
      if (!this._unloaded) this.setData({ error: error.message || '设备详情加载失败，请重试。' });
    } finally {
      if (!this._unloaded) this.setData({ loading: false });
    }
  },
  retry() { return this.loadRecord(); },
  imageFailed() { this.setData({ 'record.imageUrl': '' }); },
  copyValue(event) {
    const data = event.currentTarget.dataset.value;
    if (data) wx.setClipboardData({ data, fail() { wx.showToast({ title: '复制失败，请重试', icon: 'none' }); } });
  }
});
