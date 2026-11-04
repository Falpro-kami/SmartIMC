const { createHash } = require('node:crypto');
const GAO = 'user_1db996e0b87233a509a73b4bd6434874';
const active = member => !!member && member.teamId === 'IMC' && member.status === 'active';
const manage = member => active(member) && member._id === GAO && (member.roles || []).includes('sharing_reviewer');
const review = (member, settings) => manage(member) || active(member) && !!settings.teacherId && member._id === settings.teacherId;
const owns = (team, id) => !!team && team.participantIds.includes(id);
const phase = (event, now) => now >= event.endMs ? 'closed' : now < event.startMs ? 'upcoming' : 'open';
const uid = id => typeof id === 'string' && /^user_[a-f0-9]{32}$/.test(id);
const eventId = id => typeof id === 'string' && /^ce_[a-f0-9]{32}$/.test(id);
const teamId = id => typeof id === 'string' && /^ct_[a-f0-9]{32}$/.test(id);
const fileId = id => typeof id === 'string' && /^cf_[a-f0-9]{32}$/.test(id);
const normalized = value => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const claimId = (event, kind, value) => 'cc_' + createHash('sha256').update(event + ':' + kind + ':' + value).digest('hex').slice(0, 32);
const fileView = file => ({ id: file.id || file._id, name: file.name, size: file.size, ext: file.ext });
function reject(code, message) { const error = new Error(message); error.businessCode = code; throw error; }
module.exports = { GAO, active, manage, review, owns, phase, uid, eventId, teamId, fileId, normalized, claimId, fileView, reject };
