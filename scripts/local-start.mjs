import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { projectRoot, localSettings, backupLocalDatabase } from './local-setup.mjs';

export const repositoryUrl = 'https://github.com/wl13643464077-dev/nanowork-enterprise.git';

export function run(command, args, cwd = projectRoot, capture = false) {
  const result = spawnSync(command, args, { cwd, shell: false, windowsHide: true,
    encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} ${args[0] || ''} 执行失败，请查看上方错误；未清除任何本地改动`);
  return result.stdout?.trim() || '';
}

export function npmCli(inherited = process.env) {
  const candidates = [inherited.npm_execpath];
  for (const directory of [path.dirname(process.execPath), ...(inherited.PATH || inherited.Path || '').split(path.delimiter)]) {
    if (!directory) continue;
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
    const executable = path.join(directory, 'npm');
    if (fs.existsSync(executable)) candidates.push(fs.realpathSync(executable));
  }
  const cli = candidates.find(candidate => candidate && candidate.endsWith('.js') && fs.existsSync(candidate));
  if (!cli) throw new Error('找不到 npm。请安装包含 npm 的 Node.js 24 LTS，并重新打开终端');
  return cli;
}

export async function portOccupied(port) {
  return await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
}

export function syncSource(root = projectRoot) {
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('ZIP 下载目录不能 git 同步。请用 git clone 获取项目，或重新下载 ZIP 到新文件夹');
  if (run('git', ['status', '--porcelain'], root, true)) throw new Error('存在未提交的本地源码改动。请先保存/提交后再同步；不会自动 stash、reset 或覆盖');
  const remote = run('git', ['remote', 'get-url', 'origin'], root, true);
  if (remote !== repositoryUrl && remote !== 'git@github.com:wl13643464077-dev/nanowork-enterprise.git') throw new Error('origin 不是本项目官方仓库，停止自动同步');
  if (run('git', ['branch', '--show-current'], root, true) !== 'main') throw new Error('一键同步只更新 main；其他分支请手动合并，避免覆盖开发工作');
  run('git', ['pull', '--ff-only', 'origin', 'main'], root);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请安装 Node.js 24 LTS（含 npm），当前 Node 版本过低');
  const args = process.argv.slice(2);
  if (args.some(arg => !['--sync', '--prepare-only', '--no-open'].includes(arg))) throw new Error('用法：node scripts/local-start.mjs [--sync] [--prepare-only] [--no-open]');
  let settings = localSettings();
  if (await portOccupied(settings.port)) throw new Error(`端口 ${settings.port} 正在使用。请先在原服务窗口按 Ctrl+C 关闭再运行；不会停止其他进程`);
  const cli = npmCli();
  const backup = backupLocalDatabase(settings);
  if (backup) console.log(`已校验本机数据库备份：${backup}`);
  if (args.includes('--sync')) {
    syncSource();
    // Re-enter the freshly downloaded launcher, never continue setup with stale imported code.
    run(process.execPath, ['scripts/local-start.mjs', ...args.filter(arg => arg !== '--sync')]);
    return;
  }
  console.log('安装锁定依赖并构建（首次可能需要几分钟）……');
  run(process.execPath, [cli, '--prefix', 'server', 'ci', '--no-audit', '--no-fund']);
  run(process.execPath, [cli, '--prefix', 'web', 'ci', '--no-audit', '--no-fund']);
  run(process.execPath, [cli, 'run', 'build']);
  run(process.execPath, ['scripts/local-setup.mjs']);
  if (args.includes('--prepare-only')) { console.log('安装与初始化完成，尚未启动服务。'); return; }
  settings = localSettings();
  if (await portOccupied(settings.port)) throw new Error('准备期间端口被占用，停止启动；不会关闭其他进程');
  const child = spawn(process.execPath, ['--no-warnings', 'src/index.js'], {
    cwd: path.join(projectRoot, 'server'), stdio: 'inherit', shell: false, windowsHide: true,
  });
  let ended = false;
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { ended = true; resolve(code ?? 1); });
  });
  const stopOwnChild = () => { if (!ended) child.kill('SIGINT'); };
  process.on('SIGINT', stopOwnChild);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ended; attempt++) {
      try {
        const response = await fetch(`${settings.origin}/api/health`, { signal: AbortSignal.timeout(1500) });
        const health = await response.json();
        if (response.ok && health.db === 'up') { ready = true; break; }
      } catch { /* startup still in progress */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) { stopOwnChild(); throw new Error('服务未通过健康检查，请查看上方日志；数据和备份保留'); }
    console.log(`\n已启动：${settings.origin}/login?login=1\n请保留这个窗口；Ctrl+C 关闭服务后即可同步升级。\n首次账号：查看 server/data/local-first-login.txt；已有账号密码保持不变。`);
    if (!args.includes('--no-open')) {
      const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const browserArgs = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', `${settings.origin}/login?login=1`] : [`${settings.origin}/login?login=1`];
      const opener = spawn(command, browserArgs, { stdio: 'ignore', detached: true, windowsHide: true });
      opener.on('error', () => console.log('请手动打开上方地址。')); opener.unref();
    }
    process.exitCode = await completion;
  } finally { process.removeListener('SIGINT', stopOwnChild); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`\n启动失败：${error.message}`); process.exitCode = 1; });
}
