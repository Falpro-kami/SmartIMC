const cloud = require('wx-server-sdk');
const { randomUUID } = require('node:crypto');
const access = require('./access');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
const messages = require('./messages')(db, access);
const workbench = require('./workbench')(db, access);
const approvals = require('./approvals')(db, access, messages);
const home = require('./home')(db, access, approvals);

function reject(code, message) { const error = new Error(message); error.businessCode = code; throw error; }
function document(result) { return Array.isArray(result.data) ? result.data[0] : result.data; }
async function self(id) {
  const member = await access.readMember(db, id);
  return { ok: true, accountCode: id, member: access.present(member), roleOptions: access.allowed(member, 'equipment.read') ? access.ROLES : [],
    hasUnread: access.allowed(member, 'equipment.read') ? await messages.unread(id, member) : false };
}

exports.main = async (event = {}) => {
  const id = access.identity(cloud.getWXContext());
  if (!id) return { ok: false, code: 'AUTH_REQUIRED', message: '请从 IMC 小程序中操作。' };
  try {
    if (event.action === 'get') return await self(id);
    if (event.action !== 'apply') {
      const viewer = await access.readMember(db, id);
      if (!access.allowed(viewer, 'equipment.read')) reject('MEMBERSHIP_REQUIRED', '通过 IMC 成员审核后才能访问。');
    }
    if (event.action === 'home') return await home.dashboard(id);
    if (event.action === 'notificationState') return { ok: true, hasUnread: await messages.unread(id, await access.readMember(db, id)) };
    if (event.action === 'announcements') return await home.list(id, event);
    if (event.action === 'announcement') return await home.get(id, event);
    if (event.action === 'saveAnnouncement') return await home.save(id, event);
    if (event.action === 'withdrawAnnouncement') return await home.withdraw(id, event);
    if (event.action === 'approvals') return await approvals.list(id, event);
    if (event.action === 'workbenchUsage') return await workbench.get(id);
    if (event.action === 'recordToolOpen') return await workbench.record(id, event);
    if (event.action === 'messages') return await messages.list(id, event);
    if (event.action === 'readMessage') return await messages.read(id, event);
    if (event.action === 'openMessage') return await messages.open(id, event);
    if (event.action === 'directory') {
      const viewer = await access.readMember(db, id);
      if (!viewer || viewer.teamId !== access.TEAM_ID || viewer.status !== 'active') {
        reject('MEMBERSHIP_REQUIRED', '通过 IMC 成员审核后才能查看团队成员。');
      }
      const offset = event.offset === undefined ? 0 : event.offset;
      if (!Number.isSafeInteger(offset) || offset < 0) reject('INVALID_INPUT', '分页参数不正确。');
      // Only approved IMC members may read this limited directory; management remains separately protected.
      const result = await db.collection('teamMembers').where({ teamId: access.TEAM_ID, status: 'active' })
        .orderBy('_id', 'asc').skip(offset).limit(51).get();
      const rows = result.data.slice(0, 50);
      const profiles = rows.length ? (await db.collection('userProfiles').where({ _id: db.command.in(rows.map(row => row._id)) }).limit(50).get()).data : [];
      const profileMap = new Map(profiles.map(profile => [profile._id, profile]));
      const files = Array.from(new Set(profiles.map(profile => profile.avatarFileId).filter(file => typeof file === 'string' && file.startsWith('cloud://'))));
      const urls = new Map();
      if (files.length) {
        try {
          const response = await cloud.getTempFileURL({ fileList: files });
          for (const file of response.fileList || []) if (file.tempFileURL && /^https:\/\//.test(file.tempFileURL)) urls.set(file.fileID, file.tempFileURL);
        } catch (_) { /* A failed avatar must not prevent viewing the directory. */ }
      }
      return { ok: true, members: rows.map(row => {
        const profile = profileMap.get(row._id) || {};
        return { id: row._id, name: profile.name || '-', roleLabels: access.present(row).roleLabels,
          avatarUrl: urls.get(profile.avatarFileId) || '' };
      }), nextOffset: offset + rows.length, hasMore: result.data.length > 50 };
    }
    if (event.action === 'apply') {
      const profile = await db.collection('userProfiles').where({ _id: id }).limit(1).get();
      if (!profile.data[0] || !profile.data[0].name) reject('PROFILE_REQUIRED', '请先填写姓名后提交加入申请。');
      const appliedMs = Date.now(), reapplicationAuditId = randomUUID();
      // Fixed document identity and transaction prevent applying from overwriting an existing role.
      await db.runTransaction(async transaction => {
        const reference = transaction.collection('teamMembers').doc(id);
        const previous = document(await reference.get());
        if (previous && previous.teamId !== access.TEAM_ID) reject('FORBIDDEN', '当前账号不能提交此团队的加入申请。');
        if (previous && previous.status !== 'removed') return;
        const revision = previous ? (previous.revision || 0) + 1 : 0;
        const application = messages.applicationData(id, profile.data[0].name, appliedMs, revision);
        const data = { status: 'pending', roles: [], revision, applicationId: application._id, appliedMs,
          updatedAt: db.serverDate(), updatedBy: id };
        if (previous) {
          await reference.update({ data });
          await transaction.collection('memberAudit').doc(reapplicationAuditId).set({ data: { actorId: id, targetId: id,
            action: 'member.reapply', applicationId: application._id,
            before: { status: previous.status, roles: previous.roles || [] }, after: { status: 'pending', roles: [] }, createdAt: db.serverDate() } });
        } else await reference.set({ data: { ...data, teamId: access.TEAM_ID, createdAt: db.serverDate() } });
        await messages.put(transaction, application);
      });
      return await self(id);
    }
    const actor = await access.readMember(db, id);
    if (!access.allowed(actor, 'members.manage')) reject('FORBIDDEN', '仅超级管理员可以管理成员和权限。');
    if (event.action === 'member') {
      if (typeof event.id !== 'string' || !/^user_[a-f0-9]{32}$/.test(event.id)) reject('INVALID_INPUT', '成员参数不正确。');
      const member = await access.readMember(db, event.id);
      if (!member || member.teamId !== access.TEAM_ID || member.status === 'removed') reject('NOT_FOUND', '成员不存在。');
      const profile = await db.collection('userProfiles').where({ _id: event.id }).limit(1).get();
      return { ok: true, member: { ...access.present(member), name: profile.data[0] && profile.data[0].name || '-' } };
    }
    if (event.action === 'list') {
      const offset = event.offset === undefined ? 0 : event.offset;
      if (!Number.isSafeInteger(offset) || offset < 0) reject('INVALID_INPUT', '分页参数不正确。');
      const result = await db.collection('teamMembers').where({ teamId: access.TEAM_ID, status: db.command.in(['pending', 'active', 'disabled']) })
        .orderBy('_id', 'asc').skip(offset).limit(51).get();
      const rows = result.data.slice(0, 50);
      const profiles = rows.length ? (await db.collection('userProfiles').where({ _id: db.command.in(rows.map(row => row._id)) }).limit(50).get()).data : [];
      const names = new Map(profiles.map(profile => [profile._id, profile.name]));
      return { ok: true, members: rows.map(row => ({ ...access.present(row), name: names.get(row._id) || '-' })),
        nextOffset: offset + rows.length, hasMore: result.data.length > 50 };
    }
    if (event.action !== 'set') reject('INVALID_ACTION', '不支持的成员操作。');
    if (typeof event.id !== 'string' || !/^user_[a-f0-9]{32}$/.test(event.id) ||
      !['pending', 'active', 'disabled', 'removed'].includes(event.status) || !Array.isArray(event.roles) ||
      (event.status === 'removed' && event.roles.length !== 0) ||
      event.roles.some(role => !access.ROLES.some(option => option.value === role)) ||
      new Set(event.roles).size !== event.roles.length || !Number.isSafeInteger(event.revision) || event.revision < 0) {
      reject('INVALID_INPUT', '成员或角色参数不正确。');
    }
    const auditId = randomUUID();
    await db.runTransaction(async transaction => {
      // Read authorization again inside the transaction; a revoked administrator cannot commit a write.
      const currentActor = document(await transaction.collection('teamMembers').doc(id).get());
      const targetRef = transaction.collection('teamMembers').doc(event.id);
      const target = document(await targetRef.get());
      const securityRef = transaction.collection('teamSecurity').doc(access.TEAM_ID);
      const security = document(await securityRef.get());
      const applicationId = target && target.applicationId || messages.applicationId(event.id);
      const applicationRef = transaction.collection('teamMessages').doc(applicationId);
      const application = document(await applicationRef.get());
      if (!access.allowed(currentActor, 'members.manage') || !security || !security.superAdminIds.includes(id)) {
        reject('FORBIDDEN', '管理权限已失效，请刷新页面。');
      }
      if (!target || target.teamId !== access.TEAM_ID) reject('NOT_FOUND', '成员不存在。');
      if (target.status === 'removed') reject('NOT_FOUND', '成员已移出团队。');
      if ((target.revision || 0) !== event.revision) reject('CONFLICT', '此成员权限已更新，请重新加载后操作。');
      const superIds = new Set(security.superAdminIds);
      if (event.status === 'active' && event.roles.includes('super_admin')) superIds.add(event.id);
      else superIds.delete(event.id);
      if (!superIds.size) reject('LAST_SUPER_ADMIN', '至少需要保留一名启用中的超级管理员。');
      await targetRef.update({ data: { roles: event.roles, status: event.status,
        revision: event.revision + 1, updatedAt: db.serverDate(), updatedBy: id } });
      await securityRef.update({ data: { superAdminIds: Array.from(superIds), updatedAt: db.serverDate() } });
      await transaction.collection('memberAudit').doc(auditId).set({ data: { actorId: id, targetId: event.id,
        applicationId,
        before: { status: target.status, roles: target.roles || [] }, after: { status: event.status, roles: event.roles },
        createdAt: db.serverDate() } });
      if (application && event.status !== 'pending') await applicationRef.update({ data: { state: 'resolved' } });
      if (target.status !== event.status || JSON.stringify((target.roles || []).slice().sort()) !== JSON.stringify(event.roles.slice().sort())) {
        await messages.put(transaction, messages.changeData(auditId, event.id, target, { status: event.status, roles: event.roles }));
      }
    });
    return { ok: true };
  } catch (error) {
    if (error.businessCode) return { ok: false, code: error.businessCode, message: error.message };
    console.error('Member access failed:', error.errCode || error.code || 'ACCESS_FAILED');
    return { ok: false, code: 'ACCESS_FAILED', message: '成员服务暂时不可用，请稍后重试。' };
  }
};
