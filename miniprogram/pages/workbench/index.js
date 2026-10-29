const GROUPS = [
  {
    id: 'office', title: '办公协作', tools: [
      { id: 'approvals', name: '申请与审批', icon: '/assets/workbench/approvals.png', url: '/pages/approvals/index' },
      { id: 'leave', name: '请假', icon: '/assets/workbench/leave.png', url: '/pages/module/index?id=leave' },
      { id: 'finance', name: '财务报销', icon: '/assets/workbench/finance.png', url: '/pages/module/index?id=finance' },
      { id: 'weekly', name: '周报', icon: '/assets/workbench/weekly.png', url: '/pages/module/index?id=weekly' }
    ]
  },
  {
    id: 'growth', title: '知识成长', tools: [
      { id: 'knowledge', name: '团队知识库', icon: '/assets/workbench/knowledge.png', url: '/pages/module/index?id=knowledge' },
      { id: 'weekly-sharing', name: '每周分享', icon: '/assets/workbench/weekly-sharing.png', url: '/pages/module/index?id=weekly-sharing' },
      { id: 'ai-challenge', name: 'AI挑战赛', icon: '/assets/workbench/ai-challenge.png', url: '/pages/module/index?id=ai-challenge' }
    ]
  },
  {
    id: 'team', title: '团队服务', tools: [
      { id: 'lab-equipment', name: '实验室设备', icon: '/assets/workbench/lab-equipment.png', url: '/pages/equipment/index' },
      { id: 'activities', name: '文娱活动', icon: '/assets/workbench/activities.png', url: '/pages/module/index?id=activities' }
    ]
  }
];
const TOOLS = GROUPS.flatMap(group => group.tools);
Page(require('../../utils/member-page')({
  data: { applicationGroups: GROUPS },

  onShow() {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 1 });
  },

  openTool(event) {
    const data = event.currentTarget.dataset;
    const tool = TOOLS.find(item => item.id === data.id);
    if (!tool) return;

    wx.navigateTo({
      url: tool.url,
      fail() {
        wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
      }
    });
  }
}));
