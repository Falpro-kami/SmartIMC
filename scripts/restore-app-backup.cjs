const fs = require('node:fs');
const path = require('node:path');
const format = require(fs.existsSync(path.join(__dirname, 'lib/app-export.cjs')) ? './lib/app-export.cjs' : '../cloudfunctions/adminData/export-format');
const { privateDirectory } = require('./lib/backup-archive.cjs');
function hiddenPassword() {
  if (process.env.IMC_BACKUP_PASSWORD) return Promise.resolve(process.env.IMC_BACKUP_PASSWORD);
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal to enter the backup password');
  return new Promise((resolve, reject) => {
    let password = '';
    const input = process.stdin;
    process.stdout.write('请输入备份密码：');
    input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    const finish = () => { input.setRawMode(false); input.pause(); input.removeListener('data', handler); process.stdout.write('\n'); };
    function handler(data) {
      for (const character of data) {
        if (character === '\r' || character === '\n') { finish(); resolve(password); return; }
        if (character === '\u0003' || character === '\u0004') { finish(); reject(new Error('Cancelled')); return; }
        if (character === '\u007f' || character === '\b') password = Array.from(password).slice(0, -1).join('');
        else if (character >= ' ' && password.length < 128) password += character;
      }
    }
    input.on('data', handler);
  });
}
async function main() {
  const [mode, file, output] = process.argv.slice(2);
  if (!['verify', 'extract'].includes(mode) || !file || (mode === 'extract' && !output)) throw new Error('Usage: node scripts/restore-app-backup.cjs verify <file.imcbak> OR extract <file.imcbak> <new-output-directory>');
  const password = await hiddenPassword();
  const archive = format.decode(fs.readFileSync(file), password);
  if (mode === 'extract') {
    const root = path.resolve(output);
    if (fs.existsSync(root)) throw new Error('Restore destination already exists');
    privateDirectory(root);
    const write = (name, value) => {
      const target = path.resolve(root, format.safeName(name));
      if (!target.startsWith(root + path.sep)) throw new Error('Invalid restore path');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, value, { flag: 'wx', mode: 0o600 });
    };
    for (const table of archive.collections) {
      write('database/' + table.name + '.json', JSON.stringify(table.documents, null, 2));
      write('metadata/collections/' + table.name + '.json', JSON.stringify({ acl: table.acl, indexes: table.indexes }, null, 2));
    }
    for (const item of archive.files) write('storage/' + item.key, Buffer.from(item.base64, 'base64'));
    write('metadata/environment.json', JSON.stringify({ environment: archive.environment, storageRules: archive.storageRules }, null, 2));
  }
  console.log(JSON.stringify({ ok: true, mode, collections: archive.collections.length, documents: archive.collections.reduce((sum, item) => sum + item.documents.length, 0), cloudFiles: archive.files.length, ...(output ? { output: path.resolve(output) } : {}) }, null, 2));
}
main().catch(() => { console.error('恢复失败：请检查文件、密码及输出目录。'); process.exitCode = 1; });
