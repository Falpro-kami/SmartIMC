const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ENV = 'well-leopon-d5glrufc6e4fd4413';

function run(args) {
  // Use an installed official CLI, preserving JSON arguments without shell expansion.
  let executable = process.execPath;
  let prefix;
  if (process.env.TCB_CLI_PATH) {
    prefix = [process.env.TCB_CLI_PATH];
  } else {
    const cache = path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx');
    const candidates = fs.existsSync(cache) ? fs.readdirSync(cache).map(dir =>
      path.join(cache, dir, 'node_modules', '@cloudbase', 'cli', 'dist', 'standalone', 'cli.js')) : [];
    const cli = candidates.find(file => fs.existsSync(file));
    if (!cli) throw new Error('请先运行 npx.cmd --yes --package @cloudbase/cli@3.8.9 tcb --help 安装官方 CLI。');
    prefix = [cli];
  }
  const result = spawnSync(executable, [...prefix, ...args, '-e', ENV, '--json'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'CloudBase command failed');
  const output = result.stdout.replace(/^\uFEFF/, '').trim();
  // Deployment prints progress lines before its JSON result, even with --json.
  const jsonStart = output.search(/^\s*\{/m);
  if (jsonStart < 0) throw new Error(result.stderr || output || 'Missing CloudBase JSON result');
  const value = JSON.parse(output.slice(jsonStart));
  if (value.error) throw new Error(JSON.stringify(value.error));
  return value;
}

function execute(command, type = 'QUERY') {
  const response = run(['db', 'nosql', 'execute', '--command', JSON.stringify([
    { TableName: 'equipment', CommandType: type, Command: JSON.stringify(command) }
  ])]);
  const output = response.data.results[0];
  const unwrap = value => {
    if (Array.isArray(value)) return value.map(unwrap);
    if (value && typeof value === 'object') {
      for (const key of ['$numberInt', '$numberLong', '$numberDouble']) {
        if (key in value) return Number(value[key]);
      }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
    }
    return value;
  };
  return unwrap(output);
}

module.exports = { run, execute, ENV };
