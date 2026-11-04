const { createHash, randomUUID } = require('node:crypto');
const p = require('./challenge-policy');
const cover = require('./cover');
const csv = require('./challenge-csv');
const sync = require('./sync');
const { reject } = p;
const PREFIX = 'cloud://well-leopon-d5glrufc6e4fd4413.7765-well-leopon-d5glrufc6e4fd4413-1516940081/';
const LIMIT = 20 * 1024 * 1024;
const EXT = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'];
const doc = result => Array.isArray(result.data) ? result.data[0] : result.data;
const revision = value => Number.isSafeInteger(value) && value >= 0;
const requestId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
function signature(bytes, ext) {
  if (ext === 'pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (['docx', 'pptx', 'xlsx', 'zip'].includes(ext)) return bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
  return bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
}
module.exports = function challenge(db, cloud, access, clock = Date.now, storage = require('./storage')(cloud)) {
  const read = async (store, table, id) => doc(await store.collection(table).doc(id).get());
  async function actor(id, store = db, management = false) {
    const member = await read(store, 'teamMembers', id);
    if (!p.active(member)) reject('MEMBERSHIP_REQUIRED', '通过IMC成员审核后才能访问。');
    if (management && !p.manage(member)) reject('FORBIDDEN', '仅高创可以管理AI挑战赛。');
    return member;
  }
  async function settings(store = db) { return await read(store, 'challengeSettings', 'IMC') || { teacherId: '', revision: 0 }; }
  async function event(store, id) {
    if (!p.eventId(id)) reject('INVALID_INPUT', '赛事参数不正确。');
    const row = await read(store, 'challengeEvents', id);
    if (!row || row.teamId !== 'IMC' || row.status !== 'published') reject('NOT_FOUND', '赛事不存在。');
    return row;
  }
  async function mine(store, eid, id) {
    const claim = await read(store, 'challengeClaims', p.claimId(eid, 'member', id));
    if (!claim || !p.teamId(claim.groupId)) return null;
    const team = await read(store, 'challengeTeams', claim.groupId);
    return team && team.teamId === 'IMC' && team.eventId === eid && p.owns(team, id) ? team : null;
  }
  function eventView(row, member, config) {
    return { id: row._id, name: row.name, startMs: row.startMs, endMs: row.endMs, phase: p.phase(row, clock()),
      revision: row.revision, cover: p.fileView(row.cover), intro: p.fileView(row.intro), groupCount: row.groupCount || 0, workCount: row.workCount || 0,
      canManage: p.manage(member), canReview: p.review(member, config), canRegister: clock() < row.endMs,
      results: clock() >= row.endMs && row.results ? { revision: row.results.revision, headers: row.results.headers,
        entries: row.results.entries.map(({ groupName, score, rank, values }) => ({ groupName, score, rank, values })),
        file: p.fileView(row.results.file), publishedMs: row.results.publishedMs } : null };
  }
  function teamView(team, id, row) {
    return { id: team._id, name: team.name, leaderId: team.leaderId, leaderName: team.leaderName,
      participantIds: team.participantIds, memberIds: team.participantIds.filter(value => value !== team.leaderId), memberNames: team.memberNames,
      revision: team.revision, canEdit: id === team.leaderId && clock() < row.endMs, canUpload: p.owns(team, id) && clock() < row.endMs,
      work: team.work ? { file: p.fileView(team.work.file), version: team.work.version, uploadedMs: team.work.uploadedMs } : null };
  }
  async function notify(tx, eid, key, recipients, title, body) {
    const ids = [...new Set(recipients.filter(p.uid))]; if (!ids.length) return;
    const mid = 'msg_' + createHash('sha256').update('challenge:' + eid + ':' + key).digest('hex').slice(0, 32);
    if (await read(tx, 'teamMessages', mid)) return;
    await tx.collection('teamMessages').doc(mid).set({ data: { teamId: 'IMC', recipientKey: ids, kind: 'challenge', subjectId: eid,
      title, body, createdMs: clock(), state: 'open', readBy: [] } });
  }
  async function audit(tx, eid, id, action, details = {}) {
    await tx.collection('challengeAudit').doc(randomUUID()).set({ data: { teamId: 'IMC', eventId: eid, actorId: id, action, ...details, createdMs: clock() } });
    await sync.bump(tx, ['home', 'weekly', 'messages']);
  }
  async function get(id, data) {
    await actor(id); const row = await event(db, data.eventId), own = await mine(db, row._id, id);
    const member = await actor(id), config = await settings();
    return { ok: true, event: eventView(row, member, config), myTeam: own ? teamView(own, id, row) : null,
      ...(p.manage(member) ? { teacher: { id: config.teacherId || '', revision: config.revision || 0 } } : {}) };
  }
  async function list(id, data) {
    await actor(id);
    const offset = data.offset === undefined ? 0 : data.offset;
    if (!revision(offset)) reject('INVALID_INPUT', '分页参数不正确。');
    const filter = { teamId: 'IMC', status: 'published' };
    const result = await db.collection('challengeEvents').where(filter).orderBy('createdMs', 'desc').orderBy('_id', 'desc').skip(offset).limit(21).get();
    const member = await actor(id), config = await settings(), rows = result.data.slice(0, 20);
    return { ok: true, events: rows.map(row => eventView(row, member, config)), canManage: p.manage(member), hasMore: result.data.length > 20, nextOffset: offset + rows.length,
      ...(p.manage(member) ? { teacher: { id: config.teacherId || '', revision: config.revision || 0 } } : {}) };
  }
  async function previews(id) {
    await actor(id); const now = clock();
    const rows = await db.collection('challengeEvents').where({ teamId: 'IMC', status: 'published', startMs: db.command.lte(now), endMs: db.command.gt(now) })
      .orderBy('createdMs', 'desc').orderBy('_id', 'desc').limit(4).get();
    await actor(id);
    return { ok: true, items: rows.data.map(row => ({ id: row._id, type: 'challenge', title: row.name, cover: p.fileView(row.cover), endMs: row.endMs })) };
  }
  async function members(id, data) {
    await actor(id); if (!revision(data.offset || 0)) reject('INVALID_INPUT', '分页参数不正确。');
    const rows = (await db.collection('teamMembers').where({ teamId: 'IMC', status: 'active' }).orderBy('_id', 'asc').skip(data.offset || 0).limit(51).get()).data;
    const selected = rows.slice(0, 50), profiles = selected.length ? (await db.collection('userProfiles').where({ _id: db.command.in(selected.map(row => row._id)) }).limit(50).get()).data : [];
    await actor(id);
    return { ok: true, selfId: id, members: selected.map(row => ({ id: row._id, name: profiles.find(profile => profile._id === row._id)?.name || '未设置姓名' })), nextOffset: (data.offset || 0) + selected.length, hasMore: rows.length > 50 };
  }
  async function bindTeacher(id, data) {
    if (!p.uid(data.teacherId) || data.teacherId === p.GAO || !revision(data.revision)) reject('INVALID_INPUT', '请选择陈老师加入后的真实成员账号。');
    await db.runTransaction(async tx => {
      await actor(id, tx, true); await actor(data.teacherId, tx);
      const previous = await settings(tx);
      if ((previous.revision || 0) !== data.revision) reject('CONFLICT', '查看权限已更新，请刷新。');
      await tx.collection('challengeSettings').doc('IMC').set({ data: { teamId: 'IMC', teacherId: data.teacherId, revision: (previous.revision || 0) + 1, updatedBy: id, updatedMs: clock() } });
      await audit(tx, '', id, 'teacher.bind', { teacherId: data.teacherId });
    });
    return { ok: true };
  }
  async function ready(tx, id, fid, eid, kind, groupId = '') {
    const file = p.fileId(fid) && await read(tx, 'challengeFiles', fid);
    if (!file || file.teamId !== 'IMC' || file.eventId !== eid || file.ownerId !== id || file.kind !== kind || file.status !== 'ready' || kind === 'work' && file.groupId !== groupId) reject('FORBIDDEN', '文件未完成上传或不属于本次操作。');
    return { ...p.fileView(file), fileID: file.fileID, sha256: file.sha256 };
  }
  async function save(id, data) {
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!p.eventId(data.eventId) || !revision(data.revision) || !name || name.length > 80 || /[\x00-\x1f]/.test(name) || !Number.isSafeInteger(data.startMs) || !Number.isSafeInteger(data.endMs) || data.startMs < Date.UTC(2000, 0, 1) || data.startMs >= data.endMs || data.endMs > Date.UTC(2100, 0, 1)) reject('INVALID_INPUT', '请填写赛事名称，并设置晚于开始时间的截止时间。');
    await db.runTransaction(async tx => {
      await actor(id, tx, true);
      const previous = await read(tx, 'challengeEvents', data.eventId);
      if (previous && previous.teamId !== 'IMC') reject('FORBIDDEN', '无法修改该赛事。');
      if ((previous ? previous.revision : 0) !== data.revision) reject('CONFLICT', '赛事已更新，请重新打开。');
      if (data.endMs <= clock() || previous && previous.endMs <= clock()) reject('CLOSED', '已截止的赛事不能修改或重新开放。');
      if (previous?.groupCount && (previous.startMs !== data.startMs || previous.endMs !== data.endMs)) reject('LOCKED', '已有队伍报名，不能更改赛事开始和截止时间。');
      const attach = async (fid, kind) => previous && previous[kind]?.id === fid ? previous[kind] : ready(tx, id, fid, data.eventId, kind);
      const image = await attach(data.coverFileId, 'cover'), intro = await attach(data.introFileId, 'intro');
      const prior = { ...(previous || {}) }; delete prior._id;
      await tx.collection('challengeEvents').doc(data.eventId).set({ data: { ...prior,
        teamId: 'IMC', status: 'published', name, startMs: data.startMs, endMs: data.endMs, cover: image, intro,
        revision: data.revision + 1, groupCount: previous?.groupCount || 0, workCount: previous?.workCount || 0,
        createdMs: previous ? previous.createdMs : clock(), updatedMs: clock() } });
      await audit(tx, data.eventId, id, previous ? 'event.update' : 'event.publish');
    });
    return get(id, data);
  }
  async function register(id, data) {
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length > 30 || /[\x00-\x1f,\r\n]/.test(name) || /^[=+@-]/.test(name) || !Array.isArray(data.memberIds) || data.memberIds.length > 19 || data.memberIds.some(value => !p.uid(value) || value === id) || new Set(data.memberIds).size !== data.memberIds.length || !revision(data.revision)) reject('INVALID_INPUT', '请填写组名并选择组内成员。');
    await db.runTransaction(async tx => {
      await actor(id, tx); const row = await event(tx, data.eventId);
      if (clock() >= row.endMs) reject('CLOSED', '赛事报名已截止。');
      if (row.results) reject('LOCKED', '成绩已公布，不能修改报名。');
      const current = await mine(tx, row._id, id), groupId = current ? current._id : 'ct_' + randomUUID().replace(/-/g, '');
      if (current && current.leaderId !== id) reject('FORBIDDEN', '仅组长可以修改报名信息。');
      if ((current?.revision || 0) !== data.revision) reject('CONFLICT', '报名信息已更新，请刷新。');
      const ids = [id, ...data.memberIds], names = [];
      for (const memberId of ids) {
        await actor(memberId, tx); const profile = await read(tx, 'userProfiles', memberId);
        if (!profile?.name) reject('INVALID_INPUT', '组长及成员需先完善姓名。');
        names.push(profile.name);
        const claim = await read(tx, 'challengeClaims', p.claimId(row._id, 'member', memberId));
        if (claim?.groupId && claim.groupId !== groupId) reject('ALREADY_REGISTERED', '有成员已加入该赛事的其他组。');
      }
      const nameKey = p.claimId(row._id, 'name', p.normalized(name)), named = await read(tx, 'challengeClaims', nameKey);
      if (named?.groupId && named.groupId !== groupId) reject('DUPLICATE_NAME', '该组名已被使用。');
      const newKeys = [...ids.map(value => p.claimId(row._id, 'member', value)), nameKey];
      const oldKeys = current ? [...current.participantIds.map(value => p.claimId(row._id, 'member', value)), p.claimId(row._id, 'name', p.normalized(current.name))] : [];
      for (const key of oldKeys.filter(value => !newKeys.includes(value))) await tx.collection('challengeClaims').doc(key).set({ data: { eventId: row._id, groupId: '' } });
      for (const key of newKeys) await tx.collection('challengeClaims').doc(key).set({ data: { teamId: 'IMC', eventId: row._id, groupId } });
      await tx.collection('challengeTeams').doc(groupId).set({ data: { teamId: 'IMC', eventId: row._id, name, leaderId: id,
        leaderName: names[0], participantIds: ids, memberNames: names.slice(1), revision: data.revision + 1, work: current?.work || null,
        lastUploadRequest: current?.lastUploadRequest || '', lastUploadBy: current?.lastUploadBy || '', createdMs: current?.createdMs || clock(), updatedMs: clock() } });
      if (!current) await tx.collection('challengeEvents').doc(row._id).update({ data: { groupCount: (row.groupCount || 0) + 1 } });
      const config = await settings(tx);
      await notify(tx, row._id, 'registration:' + groupId + ':' + (data.revision + 1), [p.GAO, config.teacherId, ...ids], 'AI挑战赛报名信息已更新', row.name + '的参赛报名已更新，请打开赛事查看。');
      await audit(tx, row._id, id, 'team.register', { groupId });
    });
    return get(id, data);
  }
  async function teams(id, data) {
    const member = await actor(id), config = await settings();
    if (!p.review(member, config)) reject('FORBIDDEN', '仅高创和陈老师可查看报名队伍。');
    const row = await event(db, data.eventId), offset = data.offset || 0;
    if (!revision(offset)) reject('INVALID_INPUT', '分页参数不正确。');
    const found = await db.collection('challengeTeams').where({ teamId: 'IMC', eventId: row._id }).orderBy('createdMs', 'asc').orderBy('_id', 'asc').skip(offset).limit(21).get();
    if (!p.review(await actor(id), await settings())) reject('FORBIDDEN', '查看权限已变化。');
    const selected = found.data.slice(0, 20);
    return { ok: true, teams: selected.map(team => teamView(team, id, row)), nextOffset: offset + selected.length, hasMore: found.data.length > 20 };
  }
  async function uploadScope(store, id, eid, kind) {
    const member = await actor(id, store);
    if (kind === 'cover' || kind === 'intro') {
      if (!p.manage(member) || !p.eventId(eid)) reject('FORBIDDEN', '仅高创可上传赛事封面和介绍。');
      const previous = await read(store, 'challengeEvents', eid);
      if (previous && (previous.teamId !== 'IMC' || clock() >= previous.endMs)) reject('CLOSED', '该赛事已截止。');
      return '';
    }
    const row = await event(store, eid);
    if (kind === 'scores') { if (!p.manage(member)) reject('FORBIDDEN', '仅高创可上传评分表。'); if (clock() < row.endMs) reject('NOT_CLOSED', '截止后才可上传评分表。'); return ''; }
    if (kind !== 'work') reject('INVALID_INPUT', '文件类别不正确。');
    if (clock() >= row.endMs) reject('CLOSED', '作品提交已截止。');
    const team = await mine(store, eid, id);
    if (!team) reject('FORBIDDEN', '报名成功后才能提交本组作品。');
    return team._id;
  }
  async function prepareUpload(id, data) {
    const name = typeof data.name === 'string' ? data.name.trim() : '', ext = name.split('.').pop().toLowerCase();
    const extensions = data.kind === 'cover' ? cover.EXTENSIONS : data.kind === 'scores' ? ['csv'] : EXT;
    const max = data.kind === 'cover' ? cover.LIMIT : data.kind === 'scores' ? 256 * 1024 : LIMIT;
    if (!['cover', 'intro', 'work', 'scores'].includes(data.kind) || !name || name.length > 120 || /[\x00-\x1f/\\]/.test(name) || !extensions.includes(ext) || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > max) reject('INVALID_FILE', '文件格式或大小不正确；封面最大2MB、CSV最大256KB、其他文件最大20MB。');
    const fid = 'cf_' + randomUUID().replace(/-/g, ''), path = 'sharing-uploads/' + id + '/' + fid + '.' + ext;
    await db.runTransaction(async tx => {
      const groupId = await uploadScope(tx, id, data.eventId, data.kind);
      await tx.collection('challengeFiles').doc(fid).set({ data: { teamId: 'IMC', eventId: data.eventId, ownerId: id, groupId,
        kind: data.kind, name, ext, size: data.size, path, status: 'uploading', createdMs: clock() } });
    });
    return { ok: true, id: fid, cloudPath: path };
  }
  async function finishUpload(id, data) {
    await actor(id); const file = p.fileId(data.fileId) && await read(db, 'challengeFiles', data.fileId);
    if (!file || file.teamId !== 'IMC' || file.ownerId !== id || PREFIX + file.path !== data.fileID) reject('FORBIDDEN', '无法使用这份文件。');
    if (await uploadScope(db, id, file.eventId, file.kind) !== file.groupId) reject('FORBIDDEN', '所属参赛组已变化。');
    if (file.status === 'ready') return { ok: true, file: p.fileView(file) };
    if (file.status !== 'uploading') reject('EXPIRED', '该文件已被替换，请重新选择并上传。');
    if (clock() - file.createdMs > 86400000) reject('EXPIRED', '上传已过期。');
    const bytes = await storage.read(PREFIX + file.path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== file.size || bytes.length > LIMIT || (file.kind === 'cover' ? !cover.valid(bytes, file.ext) : file.kind === 'scores' ? bytes.length > 256 * 1024 : !signature(bytes, file.ext))) reject('INVALID_FILE', '文件实际内容、大小或格式不匹配。');
    if (file.kind === 'scores') csv.parse(bytes);
    const hash = createHash('sha256').update(bytes).digest('hex'), fileID = await storage.freeze(bytes, file.ext);
    let retained = false;
    try {
      const result = await db.runTransaction(async tx => {
        if (await uploadScope(tx, id, file.eventId, file.kind) !== file.groupId) reject('FORBIDDEN', '所属参赛组已变化。');
        const current = await read(tx, 'challengeFiles', file._id);
        if (current?.status === 'ready') return false;
        await tx.collection('challengeFiles').doc(file._id).update({ data: { status: 'ready', fileID, sha256: hash } }); return true;
      });
      retained = result === true || result?.result === true;
    } finally { if (!retained) await cloud.deleteFile({ fileList: [fileID] }).catch(() => {}); }
    await cloud.deleteFile({ fileList: [PREFIX + file.path] }).catch(() => {});
    return { ok: true, file: p.fileView(file) };
  }
  async function submit(id, data) {
    if (!requestId(data.requestId) || !revision(data.revision)) reject('INVALID_INPUT', '提交参数不正确。');
    let superseded;
    await db.runTransaction(async tx => {
      await actor(id, tx); const row = await event(tx, data.eventId), team = await mine(tx, row._id, id);
      if (!team) reject('FORBIDDEN', '只能提交本组作品。');
      if (team.lastUploadRequest === data.requestId && team.lastUploadBy === id) return;
      if (clock() >= row.endMs) reject('CLOSED', '作品提交已截止。');
      if (team.revision !== data.revision) reject('CONFLICT', '本组作品或报名已更新，请刷新后重新提交。');
      const file = await ready(tx, id, data.fileId, row._id, 'work', team._id), version = (team.work?.version || 0) + 1;
      superseded = team.work?.file?.id !== file.id ? team.work?.file : null;
      if (superseded) await tx.collection('challengeFiles').doc(superseded.id).update({ data: { status: 'superseded' } });
      await tx.collection('challengeTeams').doc(team._id).update({ data: { work: { file, version, uploadedMs: clock(), uploadedBy: id },
        revision: team.revision + 1, lastUploadRequest: data.requestId, lastUploadBy: id, updatedMs: clock() } });
      if (!team.work) await tx.collection('challengeEvents').doc(row._id).update({ data: { workCount: (row.workCount || 0) + 1 } });
      const config = await settings(tx);
      await notify(tx, row._id, 'work:' + team._id + ':' + version, [p.GAO, config.teacherId, ...team.participantIds], 'AI挑战赛作品已更新', row.name + '有参赛组更新了作品，请打开赛事查看。');
      await audit(tx, row._id, id, 'work.submit', { groupId: team._id, version });
    });
    if (superseded?.fileID) await cloud.deleteFile({ fileList: [superseded.fileID] }).catch(() => {});
    return get(id, data);
  }
  async function publishResults(id, data) {
    await actor(id, db, true); const row = await event(db, data.eventId);
    if (clock() < row.endMs) reject('NOT_CLOSED', '赛事截止后才能公布评分。');
    const file = await ready(db, id, data.fileId, row._id, 'scores');
    const parsed = csv.parse(await storage.read(file.fileID));
    const groups = [];
    for (let offset = 0; ; offset += 100) { const found = (await db.collection('challengeTeams').where({ teamId: 'IMC', eventId: row._id }).skip(offset).limit(100).get()).data; groups.push(...found); if (found.length < 100) break; }
    const names = new Map(groups.map(team => [p.normalized(team.name), team]));
    if (parsed.entries.length !== groups.length || parsed.entries.some(entry => !names.has(entry.key) || entry.rank > groups.length)) reject('INVALID_CSV', '评分表必须覆盖全部报名组，组名与报名信息一致。');
    if (!revision(data.revision)) reject('INVALID_INPUT', '评分版本不正确。');
    await db.runTransaction(async tx => {
      await actor(id, tx, true); const current = await event(tx, row._id);
      if (clock() < current.endMs || current.groupCount !== groups.length) reject('CONFLICT', '赛事状态已变化，请刷新。');
      if (current.results?.file?.id === file.id) return;
      if ((current.results?.revision || 0) !== data.revision) reject('CONFLICT', '评分结果已更新，请刷新后重试。');
      const entries = parsed.entries.sort((a, b) => a.rank - b.rank).map(entry => ({ ...entry, groupId: names.get(entry.key)._id }));
      await tx.collection('challengeEvents').doc(row._id).update({ data: { results: { headers: parsed.headers, entries, file,
        revision: data.revision + 1, publishedMs: clock() }, updatedMs: clock() } });
      for (const team of groups) await notify(tx, row._id, 'results:' + (data.revision + 1) + ':' + team._id, team.participantIds, 'AI挑战赛成绩已公布', row.name + '的评分表与组位次已公布。');
      await audit(tx, row._id, id, 'results.publish', { revision: data.revision + 1 });
    });
    return get(id, data);
  }
  async function previewResults(id, data) {
    await actor(id, db, true); const row = await event(db, data.eventId);
    if (clock() < row.endMs) reject('NOT_CLOSED', '截止后才可上传评分表。');
    const file = await ready(db, id, data.fileId, row._id, 'scores');
    const parsed = csv.parse(await storage.read(file.fileID)); await actor(id, db, true);
    return { ok: true, headers: parsed.headers, entries: parsed.entries.map(({ groupName, score, rank, values }) => ({ groupName, score, rank, values })) };
  }
  async function authorizedFile(id, data) {
    const member = await actor(id), row = await event(db, data.eventId), config = await settings();
    const publicFiles = [row.cover, row.intro, ...(clock() >= row.endMs && row.results ? [row.results.file] : [])];
    let file = publicFiles.find(item => item.id === data.fileId);
    if (!file) {
      let group;
      if (p.review(member, config)) { if (!p.teamId(data.groupId)) reject('INVALID_INPUT', '请选择参赛组。'); group = await read(db, 'challengeTeams', data.groupId); }
      else group = await mine(db, row._id, id);
      if (!group || group.teamId !== 'IMC' || group.eventId !== row._id || !p.review(member, config) && !p.owns(group, id)) reject('FORBIDDEN', '仅本组成员、高创和陈老师可查看作品。');
      file = group.work?.file;
      if (!file || file.id !== data.fileId) reject('NOT_FOUND', '该作品已被更新，请查看最新提交。');
    }
    return file;
  }
  async function downloadChunk(id, data) {
    if (!p.fileId(data.fileId) || !Number.isSafeInteger(data.offset) || data.offset < 0) reject('INVALID_INPUT', '下载参数不正确。');
    const file = await authorizedFile(id, data), length = Math.min(128 * 1024, file.size - data.offset);
    if (length <= 0) reject('INVALID_INPUT', '下载位置不正确。');
    const bytes = await storage.slice(file.fileID, data.offset, length, file.size), current = await authorizedFile(id, data);
    if (current.sha256 !== file.sha256) reject('CONFLICT', '作品或权限已变化，请重新打开。');
    return { ok: true, data: bytes.toString('base64'), nextOffset: data.offset + length, total: file.size, complete: data.offset + length === file.size };
  }
  async function dispatch(id, data) {
    const actions = { get, list, previews, members, bindTeacher, save, register, teams, prepareUpload, finishUpload, submit, previewResults, publishResults, downloadChunk,
      initialize: async uid => { await actor(uid, db, true); return require('./challenge-setup')(); } };
    if (!Object.hasOwnProperty.call(actions, data.action)) reject('INVALID_ACTION', '不支持的挑战赛操作。');
    return actions[data.action](id, data);
  }
  return { dispatch };
};
