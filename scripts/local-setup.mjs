import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateArtifact, assertPrivateArtifact } from '../server/src/engines/private-artifact.js';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

// Match server/src/env.js; values are never evaluated as shell commands.
export function parseLocalEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim(), separator = value.indexOf('=');
    if (!value || value.startsWith('#') || separator < 1) continue;
    const key = value.slice(0, separator).trim(), raw = value.slice(separator + 1).trim();
    values[key] = raw.length >= 2 && raw[0] === raw.at(-1) && ['"', "'"].includes(raw[0]) ? raw.slice(1, -1) : raw;
  }
  return values;
}

export function localSettings(root = projectRoot, inherited = process.env) {
  const envPath = path.join(root, 'server/.env');
  const values = { ...(fs.existsSync(envPath) ? parseLocalEnv(fs.readFileSync(envPath, 'utf8')) : {}), ...inherited };
  const port = Number(values.PORT || 3107);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本地端口须为1024–65535');
  if (values.HOST && values.HOST !== '127.0.0.1') throw new Error('一键启动仅支持 HOST=127.0.0.1；线上部署请使用 ops/deploy');
  if (values.NODE_ENV && values.NODE_ENV !== 'development') throw new Error('一键启动仅支持 development，不修改生产或测试配置');
  if (values.SEED_DEMO === 'true') throw new Error('一键启动不启用固定密码演示种子；请先检查 SEED_DEMO 配置');
  if (values.NANOWORK_TEST_TEMPLATE_AI === '1') throw new Error('请从普通终端启动，不使用自动测试环境');
  const databasePath = values.NANOWORK_DB ? path.resolve(root, 'server', values.NANOWORK_DB) : path.join(root, 'server/data/nanowork-industry.db');
  const relative = path.relative(path.join(root, 'server/data'), databasePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('一键启动只管理 server/data 内的本地库；自定义外部库请使用原启动方式');
  return { envPath, databasePath, port, origin: `http://127.0.0.1:${port}`, values };
}

export function initialEnvironment(template) {
  const password = randomBytes(18).toString('base64url') + '!7aA';
  const replacements = { JWT_SECRET: randomBytes(32).toString('hex'), PLATFORM_SUPER_PASSWORD: password };
  let content = template;
  for (const [key, value] of Object.entries(replacements)) {
    if (!new RegExp(`^${key}=.*$`, 'm').test(content)) throw new Error(`配置模板缺少 ${key}`);
    content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  }
  return content;
}

export function backupLocalDatabase(settings, root = projectRoot) {
  if (!fs.existsSync(settings.databasePath)) return null;
  const directory = path.join(root, 'server/data/backups');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `before-local-start-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.db`);
  const database = new DatabaseSync(settings.databasePath, { readOnly: true });
  try {
    createPrivateArtifact(target);
    database.prepare('VACUUM INTO ?').run(target);
  } finally { database.close(); }
  assertPrivateArtifact(target);
  const check = new DatabaseSync(target, { readOnly: true });
  try { if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('备份完整性检查失败'); }
  finally { check.close(); }
  return target;
}

export async function prepareLocal(root = projectRoot) {
  let settings = localSettings(root);
  const freshDatabase = !fs.existsSync(settings.databasePath);
  if (!fs.existsSync(settings.envPath)) {
    createPrivateArtifact(settings.envPath);
    fs.writeFileSync(settings.envPath, initialEnvironment(fs.readFileSync(path.join(root, 'server/.env.example'), 'utf8')));
    assertPrivateArtifact(settings.envPath);
    console.log('已创建本机私有 server/.env；不会上传 GitHub。');
  }
  settings = localSettings(root);
  if (!freshDatabase) {
    console.log('保留已有数据库、账号密码及配置，不重置。');
    return { initialized: false };
  }
  // This initializer is for a fresh database only. Normal startup performs all later migrations.
  for (const [key, value] of Object.entries(settings.values)) if (process.env[key] == null) process.env[key] = value;
  process.env.NANOWORK_DB = settings.databasePath;
  const { db, initSchema, migrateV2 } = await import(pathToFileURL(path.join(root, 'server/src/db.js')).href);
  const { ensureBaselineCatalogs } = await import(pathToFileURL(path.join(root, 'server/src/baseline.js')).href);
  const accountFile = path.join(root, 'server/data/local-first-login.txt');
  const accounts = [
    { username: settings.values.PLATFORM_SUPER_USERNAME || 'super', role: 'platform_super', name: '平台超级管理员', password: settings.values.PLATFORM_SUPER_PASSWORD || randomBytes(18).toString('base64url') + '!7aA' },
    { username: 'guan', role: 'boss', name: '企业老板', password: randomBytes(18).toString('base64url') + '!7aA' },
  ];
  try {
    initSchema(); migrateV2(); ensureBaselineCatalogs();
    if (db.prepare('SELECT COUNT(*) n FROM users').get().n !== 0) throw new Error('检测到已有账号，停止初始化，不覆盖');
    createPrivateArtifact(accountFile);
    fs.writeFileSync(accountFile, `仅供本机首次登录，请妥善保管并修改初始密码。不要上传或公开此文件。\n${settings.origin}/login?login=1\n\n` + accounts.map(account => `${account.username} (${account.role}): ${account.password}`).join('\n') + '\n');
    assertPrivateArtifact(accountFile);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const account of accounts) {
        const salt = randomBytes(16).toString('hex');
        db.prepare("INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id) VALUES(?,?,?,?,?,'启用',1)")
          .run(account.username, `${salt}:${scryptSync(account.password, salt, 32).toString('hex')}`, account.name, account.role, '管理层');
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
  console.log(`本机账号已初始化：guan（老板）、${accounts[0].username}（平台管理）。\n初始密码仅保存在私有文件：${accountFile}`);
  return { initialized: true, accountFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareLocal(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
