// Offline recovery only. This command cannot modify any cloud environment.
const path = require('node:path');
const { loadKey, verify, restore } = require('./lib/backup-archive.cjs');
const [mode, directory, output] = process.argv.slice(2);
try {
  if (!['verify', 'extract'].includes(mode) || !directory || (mode === 'extract' && !output)) throw new Error('Usage: node scripts/restore-imc.cjs verify <backup> OR extract <backup> <new-output-directory>');
  const keyFile = process.env.IMC_BACKUP_KEY_FILE || path.join(process.env.LOCALAPPDATA || process.env.HOME, 'IMC', 'backup-keys', 'imc-data.key');
  const key = loadKey(keyFile);
  const manifest = mode === 'extract' ? restore(path.resolve(directory), key, path.resolve(output)) : verify(path.resolve(directory), key).manifest;
  console.log(JSON.stringify({ ok: true, mode, envId: manifest.envId, collections: manifest.collections.map(table => ({ name: table.name, count: table.count })), cloudFiles: manifest.cloudFiles.length, ...(output ? { output: path.resolve(output) } : {}) }, null, 2));
} catch (error) { console.error('Recovery failed: ' + error.message); process.exitCode = 1; }
