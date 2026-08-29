import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = Number.parseInt(process.env.NANOWORK_DESKTOP_SMOKE_TIMEOUT_MS || '30000', 10);
const environment = {
  ...process.env,
  NANOWORK_DESKTOP_SMOKE: '1',
  NANOWORK_DESKTOP_SMOKE_PATH: process.env.NANOWORK_DESKTOP_SMOKE_PATH || '/employees?employee=101',
};
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  cwd: desktopDirectory,
  env: environment,
  stdio: 'inherit',
});

const timeout = setTimeout(() => {
  console.error(`桌面实启动验证超过 ${timeoutMs}ms，已终止。`);
  child.kill('SIGTERM');
  process.exitCode = 1;
}, timeoutMs);

child.once('error', error => {
  clearTimeout(timeout);
  console.error(`无法启动 Electron：${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  clearTimeout(timeout);
  if (process.exitCode) return;
  if (code === 0) {
    console.log('桌面实启动验证通过：服务健康检查与 NanoWork 页面渲染成功。');
    return;
  }
  console.error(`Electron 验证失败：${signal ? `signal ${signal}` : `exit ${code}`}`);
  process.exitCode = code || 1;
});
