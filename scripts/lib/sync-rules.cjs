// Grants contain no business data and are ADMINONLY. Server-only transactions revoke them.
module.exports = {
  read: "auth != null && doc._id == 'IMC' && get(`database.teamSyncAccess.${auth.openid}`).active == true && get(`database.teamSyncAccess.${auth.openid}`).teamId == 'IMC'",
  write: false
};
