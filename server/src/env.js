import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, '..', '.env');

// 测试环境不自动加载 .env（与 engines/yunwu.js 的约定一致）：
// 测试自行注入假 Key/假上游地址；否则本机 .env 的真实供应商地址会
// 盖住测试内 setConfig 的 mock 上游，让全部计费/风控断言不可复现。
const isTestTemplateAi = process.env.NANOWORK_TEST_TEMPLATE_AI === '1';

if (!isTestTemplateAi && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#') || !value.includes('=')) continue;
    const separator = value.indexOf('=');
    const key = value.slice(0, separator).trim();
    const raw = value.slice(separator + 1).trim();
    const parsed = raw.length >= 2 && raw[0] === raw.at(-1) && ['"', "'"].includes(raw[0])
      ? raw.slice(1, -1)
      : raw;
    if (key && process.env[key] == null) process.env[key] = parsed;
  }
}
