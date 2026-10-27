const { run, ENV } = require('./cloudbase.cjs');
const CORE = ['equipment', 'userProfiles', 'teamMembers', 'teamSecurity', 'memberAudit', 'teamMessages', 'workbenchUsage', 'adminBackups', 'teamAnnouncements'];
function api(action, body = {}) { return run(['api', 'tcb', action, '--body', JSON.stringify({ EnvId: ENV, ...body }), '-r', 'ap-shanghai']).data; }
async function status(url) {
  const response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) });
  await response.body?.cancel();
  return response.status;
}
async function main() {
  const report = { checkedAt: new Date().toISOString(), collections: [], storage: [], anonymousFiles: [] };
  const failures = [];
  const env = api('DescribeEnvs').EnvList.find(item => item.EnvId === ENV);
  const names = [];
  for (let offset = 0; ; offset += 100) {
    const result = api('ListTables', { Tag: env.Databases[0].InstanceId, MgoLimit: 100, MgoOffset: offset });
    const rows = result.Tables || [];
    names.push(...rows.map(row => row.TableName));
    if (rows.length < 100) break;
  }
  for (const name of CORE) if (!names.includes(name)) failures.push('Missing business collection: ' + name);
  for (const name of names) {
    const acl = api('DescribeDatabaseACL', { CollectionName: name });
    report.collections.push({ name, acl: acl.AclTag });
    const allowed = CORE.includes(name) ? ['ADMINONLY'] : ['ADMINONLY', 'PRIVATE'];
    if (!allowed.includes(acl.AclTag)) failures.push('Database permission requires review: ' + name);
  }
  for (const storage of env.Storages) {
    const rule = api('DescribeStorageSafeRule', { Bucket: storage.Bucket });
    report.storage.push({ acl: rule.AclTag });
    if (rule.AclTag !== 'PRIVATE' && rule.AclTag !== 'ADMINONLY') failures.push('Storage is not private');
    const files = run(['storage', 'list', '/']).data;
    for (const file of files) {
      if (file.key.endsWith('/')) continue;
      const encoded = file.key.split('/').map(encodeURIComponent).join('/');
      const direct = `https://${storage.Bucket}.cos.${storage.Region}.myqcloud.com/${encoded}`;
      const cdn = `https://${storage.CdnDomain}/${encoded}`;
      const link = run(['storage', 'url', file.key]).data;
      const [unsigned, cdnUnsigned, signed] = await Promise.all([status(direct), status(cdn), status(link.url)]);
      report.anonymousFiles.push({ unsigned, cdnUnsigned, signed });
      if ([unsigned, cdnUnsigned].some(code => code >= 200 && code < 300) || ![200, 206].includes(signed)) failures.push('File access probe failed');
    }
  }
  report.ok = failures.length === 0;
  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { console.error('Privacy audit failed: ' + error.message); process.exitCode = 1; });
