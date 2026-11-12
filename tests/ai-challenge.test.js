const test = require('node:test');
const assert = require('node:assert/strict');
const createDatabase = require('./helpers/memory-db');
const createChallenge = require('../cloudfunctions/weeklySharing/challenge-service');
const policy = require('../cloudfunctions/weeklySharing/challenge-policy');
const access = require('../cloudfunctions/weeklySharing/access');
const csv = require('../cloudfunctions/weeklySharing/challenge-csv');
const messages = require('../cloudfunctions/memberAccess/messages');
const createSharing = require('../cloudfunctions/weeklySharing/service');
const uid = digit => 'user_' + digit.repeat(32);
const GAO = policy.GAO, A = uid('1'), B = uid('2'), C = uid('3'), CHEN = uid('4'), SUPER = uid('5');
const EID = 'ce_' + 'a'.repeat(32), SECOND = 'ce_' + 'b'.repeat(32);
const START = Date.parse('2026-11-02T09:00:00+08:00'), END = Date.parse('2026-11-15T23:59:00+08:00');
const PREFIX = 'cloud://well-leopon-d5glrufc6e4fd4413.7765-well-leopon-d5glrufc6e4fd4413-1516940081/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64');
const PDF = Buffer.from('%PDF-1.7\nchallenge-work');
function fixture() {
  let now = START + 3600000, fileNumber = 0, duringSlice;
  const member = roles => ({ teamId: 'IMC', status: 'active', roles, revision: 0 });
  const db = createDatabase({ teamMembers: { [GAO]: member(['academic_admin']), [A]: member(['academic_admin']), [B]: member([]), [C]: member([]), [CHEN]: member(['leader']), [SUPER]: member(['super_admin']) },
    userProfiles: { [GAO]: { name: '高创' }, [A]: { name: '甲同学' }, [B]: { name: '乙同学' }, [C]: { name: '丙同学' }, [CHEN]: { name: '陈老师' }, [SUPER]: { name: '管理员' } },
    teamSync: { IMC: { home: 'h', weekly: 'w', messages: 'm', members: 'u', approvals: 'a' } } });
  const files = new Map(), deleted = [];
  const storage = { read: async id => { if (!files.has(id)) throw new Error('Missing file ' + id); return Buffer.from(files.get(id)); },
    freeze: async (bytes, ext) => { const id = 'frozen-' + ++fileNumber + '.' + ext; files.set(id, Buffer.from(bytes)); return id; },
    slice: async (id, offset, length) => { if (duringSlice) await duringSlice(); return files.get(id).subarray(offset, offset + length); } };
  const cloud = { deleteFile: async ({ fileList }) => { deleted.push(...fileList); fileList.forEach(file => files.delete(file)); } };
  const service = createChallenge(db, cloud, access, () => now, storage);
  const call = (id, action, data = {}) => service.dispatch(id, { ...data, action });
  const upload = async (id, kind, bytes = kind === 'cover' ? PNG : PDF, eid = EID, filename = kind === 'cover' ? '封面.png' : kind === 'scores' ? '成绩.csv' : '说明.pdf') => {
    const prepared = await call(id, 'prepareUpload', { eventId: eid, kind, name: filename, size: bytes.length });
    const fileID = PREFIX + prepared.cloudPath; files.set(fileID, bytes);
    return (await call(id, 'finishUpload', { fileId: prepared.id, fileID })).file;
  };
  const publish = async (eid = EID) => { const image = await upload(GAO, 'cover', PNG, eid), intro = await upload(GAO, 'intro', PDF, eid);
    return call(GAO, 'save', { eventId: eid, revision: 0, name: '测试挑战赛', startMs: START, endMs: END, coverFileId: image.id, introFileId: intro.id }); };
  const get = (id = A, eventId = EID) => call(id, 'get', { eventId });
  const register = (id = A, members = [B], name = '向量小队', revision = 0) => call(id, 'register', { eventId: EID, memberIds: members, name, revision });
  const submit = async (id, file, requestId = 'a'.repeat(32), revision) => call(id, 'submit', { eventId: EID, fileId: file.id, requestId, revision: revision ?? (await get(id)).myTeam.revision });
  return { db, call, upload, publish, get, register, submit, files, deleted, service, member,
    setTime: value => { now = value; }, onSlice: callback => { duringSlice = callback; } };
}
const rejected = (promise, code) => assert.rejects(promise, error => error.businessCode === code);

test('部署后的每周分享入口能加载挑战赛模块并执行列表查询', async () => {
  const f = fixture();
  const sharing = createSharing(f.db, {}, access, () => START, {});
  const result = await sharing.dispatch(GAO, { action: 'challenge.list' });
  assert.equal(result.ok, true);
  assert.equal(result.canManage, true);
  assert.deepEqual(result.events, []);
});

test('赛事维护固定高创，通用管理员和未绑定的陈老师均不获得私密权限', async () => {
  const f = fixture();
  for (const id of [A, CHEN, SUPER]) await rejected(f.call(id, 'prepareUpload', { eventId: EID, kind: 'cover', name: 'cover.png', size: PNG.length }), 'FORBIDDEN');
  const event = await f.publish(); assert.equal(event.event.canManage, true);
  for (const id of [A, CHEN, SUPER]) { const result = await f.get(id); assert.equal(result.event.canManage, false); assert.equal(result.event.canReview, false); }
  await rejected(f.call(SUPER, 'bindTeacher', { teacherId: CHEN, revision: 0 }), 'FORBIDDEN');
  await f.call(GAO, 'bindTeacher', { teacherId: CHEN, revision: 0 });
  assert.equal((await f.get(CHEN)).event.canReview, true);
  await rejected(f.call(CHEN, 'bindTeacher', { teacherId: C, revision: 1 }), 'FORBIDDEN');
  const json = JSON.stringify(await f.get(A)); assert.equal(json.includes('fileID'), false); assert.equal(json.includes('sha256'), false); assert.equal(json.includes('frozen-'), false);
});

test('并发报名锁定成员和规范化组名；仅组长能修改报名，成员只能参加一组', async () => {
  const f = fixture(); await f.publish();
  const attempts = await Promise.allSettled([f.register(A, [B], '向量小队'), f.register(C, [B], '蓝图组')]);
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1); assert.equal(f.db.rows('challengeTeams').length, 1);
  assert.equal((await f.get()).event.groupCount, 1);
  await rejected(f.register(B, [], '改名', 1), 'FORBIDDEN');
  await rejected(f.register(C, [], '向量小队'), 'DUPLICATE_NAME');
  const result = await f.register(A, [], 'ＡＩ组', 1); assert.equal(result.myTeam.memberIds.length, 0);
  await rejected(f.register(C, [], 'AI组'), 'DUPLICATE_NAME');
  await f.register(B, [], '蓝图组'); assert.equal((await f.get()).event.groupCount, 2);
});

test('作品只允许本组和高创及绑定的陈老师读取；重新上传覆盖旧文件，重试不会重复提交', async () => {
  const f = fixture(); await f.publish(); await f.register(); await f.call(GAO, 'bindTeacher', { teacherId: CHEN, revision: 0 });
  const first = await f.upload(A, 'work'); await f.submit(A, first); const group = (await f.get()).myTeam.id;
  for (const id of [A, B, GAO, CHEN]) assert.equal((await f.call(id, 'downloadChunk', { eventId: EID, groupId: group, fileId: first.id, offset: 0 })).complete, true);
  for (const id of [C, SUPER]) { await rejected(f.call(id, 'teams', { eventId: EID }), 'FORBIDDEN'); await rejected(f.call(id, 'downloadChunk', { eventId: EID, groupId: group, fileId: first.id, offset: 0 }), 'FORBIDDEN'); }
  const second = await f.upload(B, 'work'); await f.submit(B, second, 'b'.repeat(32)); await f.submit(B, second, 'b'.repeat(32), 0);
  assert.equal((await f.get()).myTeam.work.version, 2); assert.equal((await f.get()).event.workCount, 1);
  assert.equal(f.db.rows('challengeAudit').filter(row => row.action === 'work.submit').length, 2);
  await rejected(f.call(A, 'downloadChunk', { eventId: EID, fileId: first.id, offset: 0 }), 'NOT_FOUND');
  assert.ok(f.deleted.some(id => id.startsWith('frozen-')));
  await rejected(f.submit(A, first, 'c'.repeat(32)), 'FORBIDDEN');
  await f.call(GAO, 'bindTeacher', { teacherId: C, revision: 1 });
  await rejected(f.call(CHEN, 'downloadChunk', { eventId: EID, groupId: group, fileId: second.id, offset: 0 }), 'FORBIDDEN');
});

test('作品并发冲突不会悄悄覆盖；跨组、跨赛事和其他人的临时文件不能提交', async () => {
  const f = fixture(); await f.publish(); await f.publish(SECOND); await f.register(); await f.register(C, [], '蓝图组');
  const first = await f.upload(A, 'work'), second = await f.upload(B, 'work');
  const results = await Promise.allSettled([f.submit(A, first, 'a'.repeat(32), 1), f.submit(B, second, 'b'.repeat(32), 1)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.businessCode, 'CONFLICT');
  await rejected(f.submit(C, first, 'c'.repeat(32)), 'FORBIDDEN');
  await rejected(f.call(A, 'prepareUpload', { eventId: SECOND, kind: 'work', name: '作品.pdf', size: PDF.length }), 'FORBIDDEN');
  const config = (await f.get(GAO)).event;
  await rejected(f.submit(A, config.intro, 'd'.repeat(32)), 'FORBIDDEN');
});

test('截止瞬间禁止报名和提交，上传完成与最终提交都会重查服务端时间', async () => {
  const f = fixture(); await f.publish(); await f.register();
  const work = await f.upload(A, 'work');
  const prepared = await f.call(B, 'prepareUpload', { eventId: EID, kind: 'work', name: '作品.pdf', size: PDF.length });
  const fileID = PREFIX + prepared.cloudPath; f.files.set(fileID, PDF);
  f.setTime(END);
  await rejected(f.call(B, 'finishUpload', { fileId: prepared.id, fileID }), 'CLOSED');
  await rejected(f.submit(A, work), 'CLOSED');
  await rejected(f.register(C, [], '迟到组'), 'CLOSED');
  assert.equal((await f.get()).event.phase, 'closed');
  await rejected(f.call(A, 'prepareUpload', { eventId: EID, kind: 'work', name: '晚到.pdf', size: PDF.length }), 'CLOSED');
});

test('移出组或撤销成员身份会立即停止作品读取，包括下载中的最后一块', async () => {
  const f = fixture(); await f.publish(); await f.register(); const work = await f.upload(A, 'work'); await f.submit(A, work);
  await f.register(A, [], '向量小队', 2);
  await rejected(f.call(B, 'downloadChunk', { eventId: EID, fileId: work.id, offset: 0 }), 'FORBIDDEN');
  f.onSlice(() => f.db.put('teamMembers', A, { teamId: 'IMC', status: 'removed', roles: [] }));
  await rejected(f.call(A, 'downloadChunk', { eventId: EID, fileId: work.id, offset: 0 }), 'MEMBERSHIP_REQUIRED');
});

test('评分仅高创截止后发布，须覆盖全部组；公布后成员可读成绩但不能读他组作品', async () => {
  const f = fixture(); await f.publish(); await f.register(); await f.register(C, [], '蓝图组');
  const work = await f.upload(A, 'work'); await f.submit(A, work);
  await rejected(f.upload(GAO, 'scores', Buffer.from('组名,总分,位次\n向量小队,90,1')), 'NOT_CLOSED');
  f.setTime(END);
  for (const id of [CHEN, SUPER, A]) await rejected(f.upload(id, 'scores', Buffer.from('组名,总分,位次\n向量小队,90,1')), 'FORBIDDEN');
  const incomplete = await f.upload(GAO, 'scores', Buffer.from('组名,总分,位次\n向量小队,90,1'));
  await rejected(f.call(GAO, 'publishResults', { eventId: EID, fileId: incomplete.id, revision: 0 }), 'INVALID_CSV');
  const score = await f.upload(GAO, 'scores', Buffer.from('\uFEFF组名,创新性,总分,位次,备注\r\n向量小队,45,92.5,1,"复现,优秀"\r\n蓝图组,40,85,2,完整\r\n'));
  const preview = await f.call(GAO, 'previewResults', { eventId: EID, fileId: score.id }); assert.equal(preview.entries[0].values[4], '复现,优秀');
  assert.equal((await f.get(B)).event.results, null);
  await f.call(GAO, 'publishResults', { eventId: EID, fileId: score.id, revision: 0 });
  await f.call(GAO, 'publishResults', { eventId: EID, fileId: score.id, revision: 0 });
  assert.equal((await f.get(B)).event.results.entries.length, 2);
  assert.equal((await f.call(C, 'downloadChunk', { eventId: EID, fileId: score.id, offset: 0 })).complete, true);
  await rejected(f.call(C, 'downloadChunk', { eventId: EID, fileId: work.id, offset: 0 }), 'NOT_FOUND');
  const inbox = messages(f.db, access); const ownMessages = await inbox.list(B, {});
  const resultMessage = ownMessages.messages.find(row => row.title === 'AI挑战赛成绩已公布');
  assert.equal((await inbox.open(B, { id: resultMessage.id })).url, '/pages/module/index?id=ai-challenge&event=' + EID);
});

test('首页只显示正在进行的真实赛事，不返回报名、作品或举办人信息', async () => {
  const f = fixture(); await f.publish();
  assert.equal((await f.call(A, 'previews')).items.length, 1);
  const payload = JSON.stringify(await f.call(A, 'previews'));
  for (const privateKey of ['fileID', 'participantIds', 'leaderId', 'createdBy', 'ownerId']) assert.equal(payload.includes(privateKey), false);
  f.setTime(START - 1); assert.equal((await f.call(A, 'previews')).items.length, 0);
  f.setTime(END); assert.equal((await f.call(A, 'previews')).items.length, 0);
});

test('事务失败回滚报名和消息；已有报名时不能改时间，已截止赛事不能重新开放', async () => {
  const f = fixture(); const result = await f.publish();
  f.db.failNextWrite('challengeAudit'); await assert.rejects(f.register());
  assert.equal(f.db.rows('challengeTeams').length, 0); assert.equal(f.db.rows('challengeClaims').length, 0); assert.equal(f.db.rows('teamMessages').length, 0);
  await f.register();
  const edit = { eventId: EID, revision: 1, name: '赛事', coverFileId: result.event.cover.id, introFileId: result.event.intro.id, startMs: START, endMs: END + 1000 };
  await rejected(f.call(GAO, 'save', edit), 'LOCKED');
  f.setTime(END); await rejected(f.call(GAO, 'save', edit), 'CLOSED');
});

test('CSV拒绝公式、重复组、无效评分、未闭合引号与缺少列', () => {
  for (const text of ['组名,位次\n组,1', '组名,总分,位次\n组,=1+1,1', '组名,总分,位次\n组,1,1\n组,2,2', '组名,总分,位次\n组,x,1', '组名,总分,位次\n"组,1,1', '组名,总分,位次\n组,1,0', '组名,总分,位次,备注\n组,1,1,-cmd']) {
    assert.throws(() => csv.parse(Buffer.from(text)), error => error.businessCode === 'INVALID_CSV');
  }
});
