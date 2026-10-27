const { createHash } = require('node:crypto');
const APP_ID = 'wx875c04f31134c779';
const TEAM_ID = 'IMC';
const ROLES = [
  { value: 'leader', label: '领导' },
  { value: 'academic_admin', label: '学术管理员' },
  { value: 'five_s_admin', label: '5S管理员' },
  { value: 'finance_admin', label: '财务管理员' },
  { value: 'weekly_admin', label: '周报管理员' },
  { value: 'super_admin', label: '超级管理员' }
];
const BASE_PERMISSIONS = ['equipment.read', 'equipment.request.own', 'weekly.submit.own',
  'weekly.read.own', 'finance.submit.own', 'finance.read.own', 'activities.read', 'activities.join', 'academic.read'];
const EXTRA_PERMISSIONS = {
  leader: ['team.overview', 'weekly.read.team', 'academic.read.team'],
  academic_admin: ['academic.manage', 'academic.read.team'],
  five_s_admin: ['equipment.create', 'equipment.update', 'equipment.approve', 'five_s.manage'],
  finance_admin: ['finance.read.team', 'finance.review', 'finance.manage'],
  weekly_admin: ['weekly.read.team', 'weekly.manage', 'weekly.remind', 'weekly.export'],
  super_admin: ['*']
};
function identity(context) {
  if (!context || context.APPID !== APP_ID || !context.OPENID) return '';
  return 'user_' + createHash('sha256').update(APP_ID + ':' + context.OPENID).digest('hex').slice(0, 32);
}
function permissions(member) {
  if (!member || member.teamId !== TEAM_ID || member.status !== 'active') return [];
  return Array.from(new Set(BASE_PERMISSIONS.concat(...(member.roles || []).map(role => EXTRA_PERMISSIONS[role] || []))));
}
function allowed(member, permission) {
  const values = permissions(member);
  return values.includes('*') || values.includes(permission);
}
async function readMember(db, id) {
  const result = await db.collection('teamMembers').where({ _id: id }).limit(1).get();
  return result.data[0] || null;
}
function roleLabels(roles) {
  const labels = ROLES.filter(role => (roles || []).includes(role.value)).map(role => role.label);
  return labels.length ? labels : ['普通成员'];
}
function present(member) {
  return member ? { id: member._id, teamId: TEAM_ID, status: member.status,
    roles: member.roles || [], roleLabels: roleLabels(member.roles), revision: member.revision || 0,
    permissions: permissions(member) } : null;
}
module.exports = { APP_ID, TEAM_ID, ROLES, identity, allowed, permissions, readMember, present };
