const usage = require('../../services/workbench');
const { rankTools } = require('../../utils/workbench');
const TOOLS = [
      {
        id: 'lab-equipment',
        name: '实验室设备',
        label: '实验室设备',
        icon: '/assets/workbench/lab-equipment.png',
        url: '/pages/equipment/index'
      },
      { id: 'finance', name: '财务报销', label: '财务报销', icon: '/assets/workbench/finance.png', url: '/pages/module/index?id=finance' },
      { id: 'weekly', name: '周报', label: '周报', icon: '/assets/workbench/weekly.png', url: '/pages/module/index?id=weekly' },
      { id: 'activities', name: '文娱活动', label: '文娱活动', icon: '/assets/workbench/activities.png', url: '/pages/module/index?id=activities' },
      { id: 'ai-challenge', name: 'AI挑战赛', label: 'AI挑战赛', icon: '/assets/workbench/ai-challenge.png', url: '/pages/module/index?id=ai-challenge' },
      { id: 'approvals', name: '申请与审批', label: '申请与审批', icon: '/assets/workbench/approvals.png', url: '/pages/approvals/index' },
      { id: 'leave', name: '请假', label: '请假', icon: '/assets/workbench/leave.png', url: '/pages/module/index?id=leave' },
      { id: 'knowledge', name: '团队知识库', label: '团队知识库', icon: '/assets/workbench/knowledge.png', url: '/pages/module/index?id=knowledge' },
      { id: 'weekly-sharing', name: '每周分享', label: '每周分享', icon: '/assets/workbench/weekly-sharing.png', url: '/pages/module/index?id=weekly-sharing' }
];
Page(require('../../utils/member-page')({
  data: { tools: TOOLS, commonTools: rankTools(TOOLS) },

  onShow() {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 1 });
    this.loadUsage();
  },
  onUnload() { this._unloaded = true; },

  async loadUsage() {
    const epoch = this._usageEpoch || 0;
    try {
      const stats = await usage.load();
      if (!this._unloaded && epoch === (this._usageEpoch || 0)) this.setData({ commonTools: rankTools(TOOLS, stats) });
    } catch (_) { /* Usage statistics must not interrupt the workbench. */ }
  },

  async recordOpen(id) {
    const epoch = this._usageEpoch = (this._usageEpoch || 0) + 1;
    try {
      const stats = await usage.record(id);
      if (!this._unloaded && epoch === this._usageEpoch) this.setData({ commonTools: rankTools(TOOLS, stats) });
    } catch (_) { /* Opening an application does not depend on recording its frequency. */ }
  },

  openTool(event) {
    const data = event.currentTarget.dataset;
    const tool = TOOLS.find(item => data.id ? item.id === data.id : item.url === data.url);
    if (!tool) return;

    wx.navigateTo({
      url: tool.url,
      success: () => this.recordOpen(tool.id),
      fail() {
        wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
      }
    });
  }
}));
