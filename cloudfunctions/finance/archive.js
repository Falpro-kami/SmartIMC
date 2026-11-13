const { createHash } = require('node:crypto');
const JSZip = require('jszip');
const Excel = require('exceljs');
const studentPolicy = require('./student-policy');

const kinds = { ...studentPolicy.kinds, purchase: '购买记录' };
const safeName = (value, max) => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, max) || '材料';
const dateText = ms => Number.isFinite(ms) && ms > 0 ? new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '';

async function makeArchive(week, claims, storage, { desk = false } = {}) {
  const zip = new JSZip();
  const workbook = new Excel.Workbook();
  const sheet = workbook.addWorksheet('报销明细');
  sheet.columns = [
    { header: '申请编号', key: 'id', width: 38 },
    { header: '报销人', key: 'name', width: 16 },
    { header: '分类', key: 'category', width: 18 },
    { header: '金额（元）', key: 'amount', width: 16 },
    { header: '发票张数', key: 'count', width: 14 },
    { header: '附件目录', key: 'directory', width: 70 },
    ...(desk ? [
      { header: '提交或登记时间', key: 'submittedAt', width: 20 },
      { header: '材料提交情况', key: 'submission', width: 28 },
      { header: '报销进度', key: 'progress', width: 18 },
      { header: '进度更新时间', key: 'updatedAt', width: 20 }
    ] : [])
  ];
  sheet.getColumn('amount').numFmt = '0.00';
  const totals = workbook.addWorksheet('按人汇总');
  totals.addRow(['报销人', '申请笔数', '发票张数', '金额（元）', ...(desk ? ['已提交发票笔数', '已到账笔数', '成员目录'] : [])]);
  totals.getColumn(4).numFmt = '0.00';
  if (desk) {
    totals.getColumn(5).width = 18;
    totals.getColumn(6).width = 14;
    totals.getColumn(7).width = 50;
  }
  const people = new Map(), attachments = [], errors = [];
  const folder = zip.folder(week + '_报销材料');
  for (const claim of claims) {
    const person = people.get(claim.ownerId) || { name: claim.ownerName, count: 0, cents: 0, invoices: 0, submitted: 0, paid: 0,
      memberFolder: safeName(claim.ownerName, 24) + '_' + claim.ownerId.slice(5) };
    const directory = person.memberFolder + '/' + claim._id + '_' + safeName(claim.category || '', 16);
    const count = claim.approvedFiles.filter(file => file.kind === 'invoice').length;
    const amountKnown = Number.isSafeInteger(claim.cents);
    sheet.addRow({ id: desk ? claim.number || claim._id : claim._id, name: claim.ownerName, category: claim.category,
      amount: amountKnown ? claim.cents / 100 : undefined, count, directory: claim.approvedFiles.length ? directory : undefined,
      submittedAt: dateText(claim.createdMs), submission: claim.submission, progress: claim.progress,
      updatedAt: claim.updatedAt || dateText(claim.updatedMs) });
    person.count++;
    person.cents += amountKnown ? claim.cents : 0;
    person.invoices += count;
    if (count) person.submitted++;
    if (claim.progress === '已到账') person.paid++;
    people.set(claim.ownerId, person);
    if (desk) folder.folder(person.memberFolder);
    const names = new Set();
    for (const [index, file] of claim.approvedFiles.entries()) {
      const originalName = safeName(file.name.slice(0, -file.ext.length - 1), 60) + '.' + file.ext;
      let name = desk ? originalName : (index + 1) + '_' + (kinds[file.kind] || '附件') + '_' + originalName;
      while (names.has(name.toLowerCase())) name = (index + 1) + '_' + name;
      names.add(name.toLowerCase());
      attachments.push({ claim, file, path: directory + '/' + name });
    }
  }
  for (let offset = 0; offset < attachments.length; offset += 6) {
    await Promise.all(attachments.slice(offset, offset + 6).map(async ({ claim, file, path }) => {
      try {
        const bytes = await storage.read(file.fileID);
        if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Invalid file');
        folder.file(path, bytes);
      } catch (_) { errors.push(claim.ownerName + ' / ' + file.name); }
    }));
  }
  if (errors.length) {
    const error = new Error(errors.slice(0, 5).join('、') + (errors.length > 5 ? '等 ' + errors.length + ' 份附件' : '') + '读取失败，请重试。');
    error.businessCode = 'ARCHIVE_FILES_MISSING';
    throw error;
  }
  for (const person of people.values()) totals.addRow([person.name, person.count, person.invoices, person.cents / 100,
    ...(desk ? [person.submitted, person.paid, person.memberFolder] : [])]);
  for (const summary of [sheet, totals]) {
    summary.views = [{ state: 'frozen', ySplit: 1 }];
    summary.getRow(1).font = { bold: true };
  }
  folder.file('本周报销汇总.xlsx', await workbook.xlsx.writeBuffer());
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}
module.exports = makeArchive;
