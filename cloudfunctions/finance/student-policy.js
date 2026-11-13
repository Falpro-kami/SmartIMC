const kinds = {
  invoice: '电子发票', payment: '支付记录', photo: '实物图', detail: '发票明细',
  workList: '加工清单', trip: '行程单', paymentNotice: '缴费通知'
};

const rules = [
  { category: '材料费', threshold: 50000, optional: ['payment'], above: ['payment', 'photo'],
    hint: '未满 500 元通常无需支付记录，个别报销可按要求补充。满 500 元需支付记录和实物图。' },
  { category: '加工费', threshold: 50000, required: ['detail'], above: ['workList', 'payment'],
    hint: '未满 500 元需发票明细。满 500 元需加工清单和支付记录。' },
  { category: '交通费', hint: '网约车限武汉市内，起点或终点须为学校。高铁站、车站或机场的行程可考虑乘坐巡游出租车并使用的士票。' },
  { category: '餐饮票', confirmation: '已确认开票日非法定节假日', hint: '建议在工作日开票，单张发票建议不超过 2,000 元。' },
  { category: '网络服务使用费', threshold: 50001, above: ['payment'], confirmation: '已就本次额外采购向老师报备',
    purpose: '购买内容及项目用途', hint: 'AI 使用费已有月度补助。因项目需额外购买时，须提前向老师报备并说明购买内容。超过 500 元需支付记录。' },
  { category: '论文专利费', required: ['paymentNotice'], hint: '请同时提供缴费通知和电子发票。' },
  { category: '差旅费', confirmation: '已提前沟通本次差旅', hint: '目前差旅无需个人垫付，外出培训请提前沟通。' }
];

function requirements(rule, cents, transportMode) {
  const high = rule.threshold && cents >= rule.threshold;
  const required = ['invoice', ...(high ? rule.above : rule.required || [])];
  if (transportMode === 'ride') required.push('trip');
  return required;
}

function fileName(file, category, cents, ordinal) {
  const amount = (cents / 100).toFixed(2);
  const suffix = file.kind === 'invoice' ? '' : '_' + kinds[file.kind] + (ordinal > 1 ? '_' + ordinal : '');
  return `${category}_${amount}元${suffix}.${file.ext}`;
}

module.exports = { rules, kinds, requirements, fileName };
