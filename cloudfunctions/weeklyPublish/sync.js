const { randomUUID } = require('node:crypto');
const CHANNELS = ['home', 'messages', 'approvals', 'weekly', 'members'];
const document = result => Array.isArray(result.data) ? result.data[0] : result.data;

// Only opaque cursors are client-readable. All business records stay ADMINONLY.
async function bump(transaction, channels) {
  const data = {};
  for (const channel of channels) {
    if (!CHANNELS.includes(channel)) throw new Error('Invalid sync channel');
    data[channel] = randomUUID();
  }
  const result = await transaction.collection('teamSync').doc('IMC').update({ data });
  if (result && (result.updated === 0 || result.stats && result.stats.updated === 0)) throw new Error('Sync metadata is not initialized');
}
async function state(db) {
  const row = document(await db.collection('teamSync').doc('IMC').get());
  if (!row) throw new Error('Sync metadata is not initialized');
  return Object.fromEntries(CHANNELS.map(channel => [channel, row[channel]]));
}
async function connect(db, access, id, openid) {
  await db.runTransaction(async tx => {
    const memberRef = tx.collection('teamMembers').doc(id);
    const member = document(await memberRef.get());
    if (!access.allowed(member, 'equipment.read')) {
      const error = new Error('通过 IMC 成员审核后才能访问。');
      error.businessCode = 'MEMBERSHIP_REQUIRED'; throw error;
    }
    const grantRef = tx.collection('teamSyncAccess').doc(openid);
    const grant = document(await grantRef.get());
    // Register under the same membership transaction as revocation, preventing a stale grant.
    if (member.syncOpenid !== openid) await memberRef.update({ data: { syncOpenid: openid } });
    if (!grant || grant.memberId !== id || grant.active !== true) {
      await grantRef.set({ data: { memberId: id, teamId: 'IMC', active: true } });
    }
  });
  return { ok: true, state: await state(db) };
}
async function membership(transaction, member, status) {
  if (member.syncOpenid) await transaction.collection('teamSyncAccess').doc(member.syncOpenid)
    .set({ data: { memberId: member._id, teamId: 'IMC', active: status === 'active' } });
}
module.exports = { CHANNELS, bump, state, connect, membership };
