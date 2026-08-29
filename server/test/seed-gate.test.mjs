import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(testDir, '..');
const seedPath = path.join(serverDir, 'src', 'seed.js');

function runSeed(env) {
  const dbPath = path.join(os.tmpdir(), `nanowork-seed-gate-${process.pid}-${Math.random().toString(16).slice(2)}.db`);
  const result = spawnSync(process.execPath, ['--no-warnings', seedPath], {
    cwd: serverDir,
    env: { ...process.env, NANOWORK_DB: dbPath, JWT_SECRET: 'Nw9!pR4@xT7#qL2$kV8%mC5&zH1*sD6^', ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  return { ...result, output: `${result.stdout || ''}\n${result.stderr || ''}` };
}

function runWithDatabase(dbPath, args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd: serverDir,
    env: { ...process.env, NANOWORK_DB: dbPath, JWT_SECRET: 'Nw9!pR4@xT7#qL2$kV8%mC5&zH1*sD6^', ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function readDataMode(dbPath, seedDemo = 'false') {
  const dbUrl = pathToFileURL(path.join(serverDir, 'src', 'db.js')).href;
  const result = runWithDatabase(dbPath, ['--input-type=module', '-e',
    `const { db } = await import(${JSON.stringify(dbUrl)}); console.log(db.prepare('SELECT data_mode FROM tenants WHERE id=1').get().data_mode); db.close();`],
  { NODE_ENV: 'test', SEED_DEMO: seedDemo });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function readSeedTruthfulness(dbPath) {
  const dbUrl = pathToFileURL(path.join(serverDir, 'src', 'db.js')).href;
  const script = `
    const { db } = await import(${JSON.stringify(dbUrl)});
    const scalar = (sql, params = []) => db.prepare(sql).get(...params).n;
    const result = {
      contentCount: scalar('SELECT COUNT(*) n FROM contents'),
      nonReviewContentCount: scalar("SELECT COUNT(*) n FROM contents WHERE status <> '待审核'"),
      nonDraftContentCount: scalar("SELECT COUNT(*) n FROM contents WHERE status <> '草稿'"),
      usableOrPublishedCount: scalar("SELECT COUNT(*) n FROM contents WHERE status IN ('可使用','已发布')"),
      fabricatedEffectCount: scalar("SELECT COUNT(*) n FROM contents WHERE COALESCE(effect_views,0) <> 0 OR COALESCE(effect_leads,0) <> 0 OR channel IS NOT NULL"),
      nonTemplateContentCount: scalar("SELECT COUNT(*) n FROM contents WHERE ai_mode <> 'template'"),
      sampleBodyCount: scalar("SELECT COUNT(*) n FROM contents WHERE body LIKE '%正文示例%'"),
      unverifiedContentCount: scalar("SELECT COUNT(*) n FROM contents WHERE body LIKE '【待企业核验%'"),
      kbCount: scalar('SELECT COUNT(*) n FROM kb_docs'),
      unverifiedKbCount: scalar("SELECT COUNT(*) n FROM kb_docs WHERE body LIKE '【待企业核验的建议】%'"),
      referencedKbCount: scalar('SELECT COUNT(*) n FROM kb_docs WHERE COALESCE(ref_count,0) <> 0'),
      assistantConsultationCount: scalar("SELECT COUNT(*) n FROM ai_messages WHERE role='assistant'"),
      unverifiedConsultationCount: scalar("SELECT COUNT(*) n FROM ai_messages WHERE role='assistant' AND content LIKE '【待企业核验的会诊建议】%'"),
      assertedConsultationCount: scalar("SELECT COUNT(*) n FROM ai_messages WHERE role='assistant' AND content LIKE '%数据显示%'"),
      employeeTaskCount: scalar('SELECT COUNT(*) n FROM agent_tasks'),
      approvalCount: scalar('SELECT COUNT(*) n FROM approvals'),
      templateAssetCount: scalar("SELECT COUNT(*) n FROM biz_assets a JOIN contents c ON c.tenant_id=a.tenant_id AND c.id=a.source_id WHERE a.source_type='content' AND c.ai_mode='template' AND a.status='使用中'"),
      fakeApprovalNotificationCount: scalar("SELECT COUNT(*) n FROM notifications WHERE title='3条高风险内容待您终审'")
    };
    console.log(JSON.stringify(result));
    db.close();
  `;
  const result = runWithDatabase(dbPath, ['--input-type=module', '-e', script], { NODE_ENV: 'test', SEED_DEMO: 'false' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function readDemoOrganization(dbPath) {
  const dbUrl = pathToFileURL(path.join(serverDir, 'src', 'db.js')).href;
  const script = `
    const { db } = await import(${JSON.stringify(dbUrl)});
    const rows = db.prepare(\`SELECT u.username,u.role,u.status,m.username manager_username
      FROM users u LEFT JOIN users m ON m.id=u.manager_id AND m.tenant_id=u.tenant_id
      WHERE u.tenant_id=1 AND u.username IN ('guan','yunying','sales1','sales2','sales3','admin')
      ORDER BY u.id\`).all();
    console.log(JSON.stringify(rows));
    db.close();
  `;
  const result = runWithDatabase(dbPath, ['--input-type=module', '-e', script], { NODE_ENV: 'test', SEED_DEMO: 'false' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('直接运行 seed.js 必须显式开启演示数据门禁', () => {
  const result = runSeed({ NODE_ENV: 'test', SEED_DEMO: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /演示种子未启用/);
});

test('生产环境即使显式请求也禁止运行演示种子', () => {
  const result = runSeed({ NODE_ENV: 'production', SEED_DEMO: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /生产环境禁止运行演示种子/);
});

test('演示标记持久化，重启不依赖SEED_DEMO；已有live数据跳过时不误标', () => {
  const demoDb = path.join(os.tmpdir(), `nanowork-seed-mode-demo-${process.pid}.db`);
  const liveDb = path.join(os.tmpdir(), `nanowork-seed-mode-live-${process.pid}.db`);
  const files = [demoDb, `${demoDb}-wal`, `${demoDb}-shm`, liveDb, `${liveDb}-wal`, `${liveDb}-shm`];
  for (const file of files) fs.rmSync(file, { force: true });

  try {
    const generated = runWithDatabase(demoDb, ['--no-warnings', seedPath], { NODE_ENV: 'test', SEED_DEMO: 'true' });
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /开始生成演示数据/);
    assert.equal(readDataMode(demoDb, 'false'), 'demo');

    const dbUrl = pathToFileURL(path.join(serverDir, 'src', 'db.js')).href;
    const prepareLive = runWithDatabase(liveDb, ['--input-type=module', '-e',
      `const { db, initSchema, migrateV2 } = await import(${JSON.stringify(dbUrl)}); initSchema(); migrateV2(); db.prepare("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('existing','unused','既有用户','boss',1)").run(); db.close();`],
    { NODE_ENV: 'test', SEED_DEMO: 'false' });
    assert.equal(prepareLive.status, 0, prepareLive.stderr);
    assert.equal(readDataMode(liveDb), 'live');

    const skipped = runWithDatabase(liveDb, ['--no-warnings', seedPath], { NODE_ENV: 'test', SEED_DEMO: 'true' });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /已有数据，跳过/);
    assert.equal(readDataMode(liveDb, 'false'), 'live');
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
});

test('全新演示库首次生成即建立老板到管理层再到员工的组织层级', () => {
  const dbPath = path.join(os.tmpdir(), `nanowork-seed-org-${process.pid}.db`);
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  for (const file of files) fs.rmSync(file, { force: true });

  try {
    const generated = runWithDatabase(dbPath, ['--no-warnings', seedPath], { NODE_ENV: 'test', SEED_DEMO: 'true' });
    assert.equal(generated.status, 0, generated.stderr);

    const byUsername = Object.fromEntries(readDemoOrganization(dbPath).map(row => [row.username, row]));
    assert.deepEqual(Object.keys(byUsername).sort(), ['admin', 'guan', 'sales1', 'sales2', 'sales3', 'yunying']);
    assert.equal(byUsername.guan.manager_username, null);
    assert.equal(byUsername.yunying.manager_username, 'guan');
    assert.equal(byUsername.admin.manager_username, 'guan');
    for (const username of ['sales1', 'sales2', 'sales3']) {
      assert.equal(byUsername[username].manager_username, 'yunying');
      assert.equal(byUsername[username].status, '启用');
    }
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
});

test('种子内容、知识库与会诊建议保持待企业核验，不伪装发布效果', () => {
  const dbPath = path.join(os.tmpdir(), `nanowork-seed-truthfulness-${process.pid}.db`);
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  for (const file of files) fs.rmSync(file, { force: true });

  try {
    const generated = runWithDatabase(dbPath, ['--no-warnings', seedPath], { NODE_ENV: 'test', SEED_DEMO: 'true' });
    assert.equal(generated.status, 0, generated.stderr);

    const snapshot = readSeedTruthfulness(dbPath);
    assert.ok(snapshot.contentCount > 0);
    assert.equal(snapshot.nonDraftContentCount, 0);
    assert.equal(snapshot.usableOrPublishedCount, 0);
    assert.equal(snapshot.fabricatedEffectCount, 0);
    assert.equal(snapshot.nonTemplateContentCount, 0);
    assert.equal(snapshot.sampleBodyCount, 0);
    assert.equal(snapshot.unverifiedContentCount, snapshot.contentCount);

    assert.ok(snapshot.kbCount > 0);
    assert.equal(snapshot.unverifiedKbCount, snapshot.kbCount);
    assert.equal(snapshot.referencedKbCount, 0);

    assert.ok(snapshot.assistantConsultationCount > 0);
    assert.equal(snapshot.unverifiedConsultationCount, snapshot.assistantConsultationCount);
    assert.equal(snapshot.assertedConsultationCount, 0);

    assert.equal(snapshot.employeeTaskCount, 0, '未真实派活前不得伪造数字员工任务');
    assert.equal(snapshot.approvalCount, 0, '种子不得用随机 target_id 伪造审批');
    assert.equal(snapshot.templateAssetCount, 0, '模板草稿不得成为使用中内容资产');
    assert.equal(snapshot.fakeApprovalNotificationCount, 0, '无待审时不得伪造审批通知');
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
});
