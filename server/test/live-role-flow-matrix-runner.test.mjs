import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  LIVE_ROLE_FLOW_CHECKPOINT_SCHEMA,
  LIVE_ROLE_FLOW_ISOLATION_MARKER,
  LIVE_ROLE_FLOW_MATRIX_SCHEMA,
  LIVE_ROLE_FLOW_PLAN,
  assertForbiddenFullDatabaseNoSideEffects,
  assertForbiddenPersistentBoundaryUnchanged,
  assertContentDispatchSnapshotMatchesAuthority,
  assertFreshOfficialYunwuReadiness,
  assertIsolationMarker,
  assertProfileAccessMatrix,
  assertSafeArtifactPath,
  buildSameOriginRequestUrl,
  capturePersistentSideEffectBoundary,
  captureFullTenantSnapshot,
  captureWatermarks,
  collectFlowEvidence,
  computeDatabaseIdentityFingerprint,
  computeFilesFingerprint,
  computeScenarioFingerprint,
  findUniqueNonceBoundAiState,
  fetchSameOriginNoRedirect,
  hashValue,
  isLoopbackBaseUrl,
  parseCredentialsFromStdin,
  positiveWhitelistEvidence,
  reconcileNonceMutation,
  reserveExclusiveArtifactPath,
  roleMatchesLiveLane,
  summarizeFullTenantSnapshot,
  summarizeRunChecks,
  validateBoundFlowEvidence,
  validateCheckpoint,
  validateFinalFlowEvidence,
  writeJsonExclusive0600,
} from "../../scripts/lib/live-role-flow-matrix.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const runnerPath = path.join(
  projectRoot,
  "scripts/run-live-role-flow-matrix.mjs",
);
const packagePath = path.join(projectRoot, "package.json");
const temporaryPaths = [];
let db;
let currentDbPath;
const BATCH_NONCE = "live-role-test-batch-0001";

function recursivelyListCodeDependencyFiles(root) {
  const files = [];
  for (const entry of fs
    .readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...recursivelyListCodeDependencyFiles(absolute));
    else if (entry.isFile() && /\.(?:js|mjs|cjs|json|md)$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

function fixtureDatabase() {
  const dbPath = path.join(
    os.tmpdir(),
    `nanowork-live-role-runner-${process.pid}-${Date.now()}-${Math.random()}.db`,
  );
  temporaryPaths.push(dbPath, `${dbPath}-wal`, `${dbPath}-shm`);
  currentDbPath = dbPath;
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE tenants(
      id INTEGER PRIMARY KEY,name TEXT,status TEXT,data_mode TEXT,credits INTEGER,note TEXT
    );
    CREATE TABLE users(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,username TEXT,password_hash TEXT,name TEXT,
      role TEXT,status TEXT,manager_id INTEGER,modules TEXT,last_login_at TEXT
    );
    CREATE TABLE sys_config(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,title TEXT,type TEXT,status TEXT,
      assignee_id INTEGER,assigned_by INTEGER,parent_task_id INTEGER,source TEXT,
      created_at TEXT,done_at TEXT,detail TEXT
    );
    CREATE TABLE task_submissions(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,task_id INTEGER,user_id INTEGER,
      content TEXT,result TEXT,source_ref_type TEXT,source_ref_id INTEGER,
      reviewer_id INTEGER,reviewed_at TEXT,created_at TEXT
    );
    CREATE TABLE agent_tasks(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,marshal_id INTEGER,specialist_id INTEGER,
      title TEXT,type TEXT,status TEXT,output_id INTEGER,created_by INTEGER,
      requirement TEXT,employee_web_snapshot TEXT,created_at TEXT
    );
    CREATE TABLE content_employee_runs(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,employee_idx INTEGER,employee_key TEXT,
      employee_name TEXT,employee_group TEXT,title TEXT,type TEXT,status TEXT,
      requirement TEXT,ai_mode TEXT,model TEXT,snapshot_json TEXT,created_by INTEGER,created_at TEXT,updated_at TEXT
    );
    CREATE TABLE credit_holds(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,user_id INTEGER,log_id INTEGER,
      feature TEXT,kind TEXT,model TEXT,held_credits INTEGER,settled_credits INTEGER,
      status TEXT,ref_type TEXT,ref_id INTEGER,created_at TEXT,settled_at TEXT
    );
    CREATE TABLE credit_logs(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,user_id INTEGER,feature TEXT,kind TEXT,
      model TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_yuan REAL,credits INTEGER,
      balance_after INTEGER,ai_mode TEXT,note TEXT,created_at TEXT
    );
    CREATE TABLE contents(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,type TEXT,title TEXT,body TEXT,status TEXT,
      ai_mode TEXT,creator_id INTEGER,marshal_id INTEGER,content_employee_idx INTEGER,
      source_type TEXT,source_id INTEGER,created_at TEXT
    );
    CREATE TABLE approvals(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,target_type TEXT,target_id INTEGER,
      title TEXT,summary TEXT,status TEXT,submitter_id INTEGER,reviewer_id INTEGER,
      approval_level TEXT,parent_id INTEGER,created_at TEXT,decided_at TEXT
    );
    CREATE TABLE materials(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,name TEXT,type TEXT,source_type TEXT,
      source_id INTEGER,creator_id INTEGER,body_snapshot TEXT,created_at TEXT
    );
    CREATE TABLE biz_assets(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,name TEXT,category TEXT,status TEXT,
      source_type TEXT,source_id INTEGER,creator_id INTEGER,note TEXT,created_at TEXT
    );
    CREATE TABLE kb_docs(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,category TEXT,title TEXT,body TEXT,
      source_type TEXT,source_id INTEGER,enabled INTEGER,version INTEGER,updated_at TEXT
    );
    CREATE TABLE notifications(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,user_id INTEGER,type TEXT,title TEXT,
      body TEXT,link TEXT,read INTEGER,created_at TEXT
    );
    CREATE TABLE op_logs(
      id INTEGER PRIMARY KEY,tenant_id INTEGER,user_id INTEGER,username TEXT,module TEXT,
      action TEXT,target TEXT,ip TEXT,created_at TEXT
    );
    CREATE TABLE unrelated_global(id INTEGER PRIMARY KEY,value TEXT);

    INSERT INTO tenants VALUES(1,'隔离租户','已开通','live',10000,'private-note');
    INSERT INTO users VALUES(1,1,'boss','secret-hash','老板','boss','启用',NULL,NULL,NULL);
    INSERT INTO users VALUES(2,1,'manager','secret-hash','经理','ops_director','启用',1,NULL,NULL);
    INSERT INTO users VALUES(3,1,'employee','secret-hash','员工','sales','启用',2,NULL,NULL);
    INSERT INTO sys_config VALUES('secret_config:1','must-stay-in-memory-only');
    INSERT INTO unrelated_global VALUES(1,'not-tenant-scoped');
  `);
  database
    .prepare("INSERT INTO sys_config(key,value) VALUES(?,?)")
    .run(
      "live_role_matrix_isolated:1",
      JSON.stringify({
        marker: LIVE_ROLE_FLOW_ISOLATION_MARKER,
        testOnly: true,
        purpose: "live-role-flow-matrix",
        tenantId: 1,
        databaseId: "live-role-fixture-database-0001",
        allowedBatchNonceSha256: hashValue(BATCH_NONCE),
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );
  return database;
}

beforeEach(() => {
  try {
    db?.close();
  } catch {
    // Previous test may already have closed it.
  }
  db = fixtureDatabase();
});

after(() => {
  try {
    db?.close();
  } catch {
    // Already closed.
  }
  for (const target of temporaryPaths)
    fs.rmSync(target, { force: true, recursive: true });
});

test("live矩阵schema与三条业务链定义完整", () => {
  assert.equal(
    LIVE_ROLE_FLOW_MATRIX_SCHEMA,
    "nanowork.live-role-flow-matrix.v2",
  );
  assert.deepEqual(
    LIVE_ROLE_FLOW_PLAN.map((item) => item.id),
    ["human_task_hierarchy", "restaurant_employee", "content_employee"],
  );
  assert.equal(
    LIVE_ROLE_FLOW_PLAN.filter((item) => item.requiresCloudAi).length,
    2,
  );
  const manual = LIVE_ROLE_FLOW_PLAN[0];
  assert.ok(manual.positiveFlow.includes("management_reject_child"));
  assert.ok(manual.positiveFlow.includes("employee_resubmit_child"));
  assert.ok(manual.forbiddenFlow.includes("management_review_own_parent"));
});

test("三角色凭据只接受严格stdin JSON且不合并缺失角色", () => {
  const parsed = parseCredentialsFromStdin(
    JSON.stringify({
      boss: { username: "boss", password: "boss-pass" },
      management: { username: "manager", password: "manager-pass" },
      employee: { username: "employee", password: " employee-pass " },
    }),
  );
  assert.equal(parsed.management.username, "manager");
  assert.equal(parsed.employee.password, " employee-pass ");
  assert.throws(
    () =>
      parseCredentialsFromStdin(
        JSON.stringify({
          boss: { username: "boss", password: "x" },
          management: { username: "manager", password: "x" },
        }),
      ),
    /employee凭据必须是对象/u,
  );
  assert.throws(() => parseCredentialsFromStdin("not-json"), /合法JSON/u);
});

test("凭据拒绝额外字段、重复账号、换行和超长输入", () => {
  const valid = {
    boss: { username: "boss", password: "boss-pass" },
    management: { username: "manager", password: "manager-pass" },
    employee: { username: "employee", password: "employee-pass" },
  };
  assert.throws(
    () => parseCredentialsFromStdin(JSON.stringify({ ...valid, apiKey: "no" })),
    /未知角色/u,
  );
  assert.throws(
    () =>
      parseCredentialsFromStdin(
        JSON.stringify({
          ...valid,
          employee: { ...valid.employee, token: "no" },
        }),
      ),
    /未知字段/u,
  );
  assert.throws(
    () =>
      parseCredentialsFromStdin(
        JSON.stringify({
          ...valid,
          employee: { ...valid.employee, username: "BOSS" },
        }),
      ),
    /三个不同账号/u,
  );
  assert.throws(
    () =>
      parseCredentialsFromStdin(
        JSON.stringify({
          ...valid,
          employee: { ...valid.employee, password: "bad\nvalue" },
        }),
      ),
    /非法字符/u,
  );
  assert.throws(() => parseCredentialsFromStdin("x".repeat(16_385)), /16KB/u);
});

test("loopback地址守卫拒绝HTTPS、外网、userinfo和路径混淆", () => {
  assert.equal(isLoopbackBaseUrl("http://127.0.0.1:3107"), true);
  assert.equal(isLoopbackBaseUrl("http://localhost:3107/"), true);
  assert.equal(isLoopbackBaseUrl("http://[::1]:3107"), true);
  assert.equal(isLoopbackBaseUrl("https://127.0.0.1:3107"), false);
  assert.equal(isLoopbackBaseUrl("http://127.0.0.1.example.com:3107"), false);
  assert.equal(isLoopbackBaseUrl("http://user:pass@127.0.0.1:3107"), false);
  assert.equal(isLoopbackBaseUrl("http://127.0.0.1:3107/api"), false);
});

test("请求URL只能使用同源loopback绝对路径", () => {
  assert.equal(
    buildSameOriginRequestUrl("http://127.0.0.1:3107", "/api/health?x=1").href,
    "http://127.0.0.1:3107/api/health?x=1",
  );
  assert.throws(
    () => buildSameOriginRequestUrl("http://127.0.0.1:3107", "//evil.test/x"),
    /站内绝对路径/u,
  );
  assert.throws(
    () => buildSameOriginRequestUrl("http://evil.test", "/api/health"),
    /loopback/u,
  );
});

test("302无论同源或异源都不跟随，Authorization和登录体不会到达重定向目标", async () => {
  let sameOriginTargetHits = 0;
  let crossOriginTargetHits = 0;
  const crossTarget = http.createServer((request, response) => {
    crossOriginTargetHits += 1;
    response.end("unexpected");
  });
  crossTarget.listen(0, "127.0.0.1");
  await once(crossTarget, "listening");
  const crossPort = crossTarget.address().port;
  const source = http.createServer((request, response) => {
    if (request.url === "/same-target") {
      sameOriginTargetHits += 1;
      response.end("unexpected");
      return;
    }
    response.statusCode = 302;
    response.setHeader(
      "location",
      request.url === "/same"
        ? "/same-target"
        : `http://127.0.0.1:${crossPort}/cross-target`,
    );
    response.end();
  });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");
  const baseUrl = `http://127.0.0.1:${source.address().port}`;
  try {
    for (const route of ["/same", "/cross"]) {
      await assert.rejects(() =>
        fetchSameOriginNoRedirect(baseUrl, route, {
          method: "POST",
          headers: {
            authorization: "Bearer must-not-forward",
            "content-type": "application/json",
          },
          body: JSON.stringify({ password: "must-not-forward" }),
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sameOriginTargetHits, 0);
    assert.equal(crossOriginTargetHits, 0);
  } finally {
    source.close();
    crossTarget.close();
    await Promise.all([once(source, "close"), once(crossTarget, "close")]);
  }
});

test("角色lane严格区分老板、管理层和普通员工", () => {
  assert.equal(roleMatchesLiveLane("boss", "boss"), true);
  assert.equal(roleMatchesLiveLane("boss", "admin"), false);
  assert.equal(roleMatchesLiveLane("management", "ops_director"), true);
  assert.equal(roleMatchesLiveLane("management", "manager"), true);
  assert.equal(roleMatchesLiveLane("employee", "sales"), true);
  assert.equal(roleMatchesLiveLane("employee", "staff"), true);
  assert.equal(roleMatchesLiveLane("employee", "partner"), false);
  assert.equal(roleMatchesLiveLane("employee", "boss"), false);
});

test("证据采用正向白名单并递归移除令牌、密码、原始正文和API密钥", () => {
  const projected = positiveWhitelistEvidence({
    schema: LIVE_ROLE_FLOW_MATRIX_SCHEMA,
    ok: true,
    actors: {
      boss: {
        id: 1,
        name: "老板",
        role: "boss",
        token: "eyJaaaaaaaa.bbbbbbbb.cccccccc",
        password: "secret",
      },
    },
    contents: [
      {
        id: 8,
        status: "可使用",
        body: "full private output",
        snapshot_json: "private prompt",
      },
    ],
    apiKey: "sk-abcdefghijklmnop",
    rawResponse: { authorization: "Bearer abcdefghijklmnop" },
  });
  assert.deepEqual(projected.actors.boss, {
    id: 1,
    name: "老板",
    role: "boss",
  });
  assert.deepEqual(projected.contents, [{ id: 8, status: "可使用" }]);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /secret|private output|private prompt|sk-/u);
  assert.doesNotMatch(serialized, /authorization|token|password/iu);
});

test("证据路径拒绝主库、sidecar、硬链接和已有文件，新文件以0600独占创建", () => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    assert.throws(
      () =>
        assertSafeArtifactPath({
          databasePath: currentDbPath,
          artifactPath: `${currentDbPath}${suffix}`,
        }),
      /sidecar/u,
    );
  }
  const hardlink = `${currentDbPath}.hardlink.json`;
  fs.linkSync(currentDbPath, hardlink);
  temporaryPaths.push(hardlink);
  assert.throws(
    () =>
      assertSafeArtifactPath({
        databasePath: currentDbPath,
        artifactPath: hardlink,
      }),
    /硬链接/u,
  );
  const output = `${currentDbPath}.evidence.json`;
  temporaryPaths.push(output);
  reserveExclusiveArtifactPath({ databasePath: currentDbPath, artifactPath: output });
  writeJsonExclusive0600(output, { ok: true });
  assert.equal(fs.statSync(output).mode & 0o077, 0);
  assert.throws(
    () => reserveExclusiveArtifactPath({ databasePath: currentDbPath, artifactPath: output }),
    /拒绝覆盖/u,
  );
  assert.throws(() => writeJsonExclusive0600(output, { ok: false }), /EEXIST/u);

  const protectedFixture = path.join(
    os.tmpdir(),
    `live-role-protected-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(protectedFixture, "db", "utf8");
  temporaryPaths.push(protectedFixture);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const protectedPath = `${protectedFixture}${suffix}`;
    if (suffix) {
      fs.writeFileSync(protectedPath, suffix, "utf8");
      temporaryPaths.push(protectedPath);
    }
    const alias = `${protectedFixture}${suffix}.alias`;
    fs.linkSync(protectedPath, alias);
    temporaryPaths.push(alias);
    assert.throws(
      () =>
        assertSafeArtifactPath({
          databasePath: protectedFixture,
          artifactPath: alias,
        }),
      /硬链接/u,
    );
  }
});

test("CLI在读取凭据或执行云调用前拒绝out与checkpoint同文件及symlink别名", () => {
  const credentials = JSON.stringify({
    boss: { username: "boss", password: "unused" },
    management: { username: "manager", password: "unused" },
    employee: { username: "employee", password: "unused" },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-role-alias-"));
  temporaryPaths.push(root);
  const aliasRoot = `${root}-link`;
  fs.symlinkSync(root, aliasRoot, "dir");
  temporaryPaths.push(aliasRoot);
  for (const [output, checkpoint] of [
    [path.join(root, "same.json"), path.join(root, "same.json")],
    [path.join(root, "alias.json"), path.join(aliasRoot, "alias.json")],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        runnerPath,
        "--credentials-stdin",
        "--allow-ai-cloud",
        "--db",
        currentDbPath,
        "--batch-nonce",
        BATCH_NONCE,
        "--out",
        output,
        "--checkpoint",
        checkpoint,
      ],
      { input: credentials, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /两个不同文件/u);
    assert.equal(fs.existsSync(output), false);
  }
});

test("完整租户快照覆盖全部tenant_id表、租户行与租户配置且隔离其他租户", () => {
  const snapshot = captureFullTenantSnapshot(db, 1);
  assert.ok(snapshot.tables.users);
  assert.ok(snapshot.tables.tasks);
  assert.ok(snapshot.tables.credit_holds);
  assert.equal(snapshot.tables.users.length, 3);
  assert.equal(
    snapshot.tables.users.some((row) => row.username === "other"),
    false,
  );
  assert.equal(snapshot.tables.unrelated_global, undefined);
  assert.equal(snapshot.tenant.name, "隔离租户");
  assert.equal(snapshot.tenantConfig.length, 2);
  const summary = summarizeFullTenantSnapshot(snapshot);
  assert.match(summary.digest, /^[a-f0-9]{64}$/u);
  assert.equal(summary.tableCounts.users, 3);
});

test("403完整数据库零副作用证明可通过且摘要不暴露行内容", () => {
  const before = captureFullTenantSnapshot(db, 1);
  const after = captureFullTenantSnapshot(db, 1);
  const proof = assertForbiddenFullDatabaseNoSideEffects({
    label: "staff review",
    status: 403,
    before,
    after,
  });
  assert.equal(proof.unchanged, true);
  assert.equal(proof.before.tableCounts.users, 3);
  assert.equal(JSON.stringify(proof).includes("secret-hash"), false);
});

test("403完整快照能发现插入、更新和删除副作用", () => {
  for (const mutation of [
    () =>
      db.exec(
        "INSERT INTO tasks VALUES(1,1,'new','数据','待执行',3,2,NULL,'手动',NULL,NULL,'')",
      ),
    () => db.exec("UPDATE tenants SET credits=credits-1 WHERE id=1"),
    () => db.exec("DELETE FROM users WHERE id=3"),
  ]) {
    const before = captureFullTenantSnapshot(db, 1);
    mutation();
    const after = captureFullTenantSnapshot(db, 1);
    assert.throws(
      () =>
        assertForbiddenFullDatabaseNoSideEffects({
          label: "mutation",
          status: 403,
          before,
          after,
        }),
      /changed tenant database state/u,
    );
    db.close();
    db = fixtureDatabase();
  }
});

test("403本地持久化边界同时发现全局表和数据文件副作用且不夸大外部覆盖", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "live-role-boundary-"));
  temporaryPaths.push(dataRoot);
  const tracked = path.join(dataRoot, "state.json");
  fs.writeFileSync(tracked, "before", "utf8");
  const before = capturePersistentSideEffectBoundary({
    db,
    databasePath: currentDbPath,
    dataRoot,
  });
  const same = capturePersistentSideEffectBoundary({
    db,
    databasePath: currentDbPath,
    dataRoot,
  });
  const proof = assertForbiddenPersistentBoundaryUnchanged({
    label: "forbidden",
    status: 403,
    before,
    after: same,
  });
  assert.equal(proof.proofType, "403_persistent_local_boundary");
  assert.equal(proof.externalSideEffectsCoverage, "not_instrumented");
  db.exec("UPDATE unrelated_global SET value='changed' WHERE id=1");
  const afterGlobal = capturePersistentSideEffectBoundary({
    db,
    databasePath: currentDbPath,
    dataRoot,
  });
  assert.throws(
    () =>
      assertForbiddenPersistentBoundaryUnchanged({
        label: "global",
        status: 403,
        before,
        after: afterGlobal,
      }),
    /measured local persistent boundary/u,
  );
  db.exec("UPDATE unrelated_global SET value='not-tenant-scoped' WHERE id=1");
  fs.writeFileSync(tracked, "after", "utf8");
  const afterFile = capturePersistentSideEffectBoundary({
    db,
    databasePath: currentDbPath,
    dataRoot,
  });
  assert.throws(
    () =>
      assertForbiddenPersistentBoundaryUnchanged({
        label: "file",
        status: 403,
        before,
        after: afterFile,
      }),
    /measured local persistent boundary/u,
  );
});

test("403持久化边界能发现schema、自增序列、空目录与权限元数据变化", () => {
  db.exec("CREATE TABLE sequenced(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT)");
  const beforeSequence = capturePersistentSideEffectBoundary({
    db,
    databasePath: currentDbPath,
  });
  db.exec("INSERT INTO sequenced(value) VALUES('temporary'); DELETE FROM sequenced");
  const afterSequence = capturePersistentSideEffectBoundary({
    db,
    databasePath: currentDbPath,
  });
  assert.throws(
    () =>
      assertForbiddenPersistentBoundaryUnchanged({
        label: "sequence",
        status: 403,
        before: beforeSequence,
        after: afterSequence,
      }),
    /measured local persistent boundary/u,
  );

  const beforeSchema = afterSequence;
  db.exec("ALTER TABLE unrelated_global ADD COLUMN extra TEXT");
  const afterSchema = capturePersistentSideEffectBoundary({
    db,
    databasePath: currentDbPath,
  });
  assert.throws(
    () =>
      assertForbiddenPersistentBoundaryUnchanged({
        label: "schema",
        status: 403,
        before: beforeSchema,
        after: afterSchema,
      }),
    /measured local persistent boundary/u,
  );

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "live-role-file-meta-"));
  temporaryPaths.push(dataRoot);
  const tracked = path.join(dataRoot, "tracked.txt");
  fs.writeFileSync(tracked, "same-content", { mode: 0o600 });
  const beforeDirectory = capturePersistentSideEffectBoundary({
    db,
    databasePath: currentDbPath,
    dataRoots: [dataRoot],
  });
  fs.mkdirSync(path.join(dataRoot, "empty"));
  const afterDirectory = capturePersistentSideEffectBoundary({
    db,
    databasePath: currentDbPath,
    dataRoots: [dataRoot],
  });
  assert.throws(
    () =>
      assertForbiddenPersistentBoundaryUnchanged({
        label: "empty-directory",
        status: 403,
        before: beforeDirectory,
        after: afterDirectory,
      }),
    /measured local persistent boundary/u,
  );
  const beforeMode = afterDirectory;
  fs.chmodSync(tracked, 0o644);
  const afterMode = capturePersistentSideEffectBoundary({
    db,
    databasePath: currentDbPath,
    dataRoots: [dataRoot],
  });
  assert.throws(
    () =>
      assertForbiddenPersistentBoundaryUnchanged({
        label: "file-mode",
        status: 403,
        before: beforeMode,
        after: afterMode,
      }),
    /measured local persistent boundary/u,
  );
});

test("403证明拒绝200等非权限拒绝状态", () => {
  const snapshot = captureFullTenantSnapshot(db, 1);
  assert.throws(
    () =>
      assertForbiddenFullDatabaseNoSideEffects({
        label: "wrong status",
        status: 200,
        before: snapshot,
        after: snapshot,
      }),
    /expected HTTP 403/u,
  );
});

test("隔离标记强绑定唯一租户、数据库身份、限时窗口与batch nonce", () => {
  const isolation = assertIsolationMarker(db, 1, {
    batchNonce: BATCH_NONCE,
    databasePath: currentDbPath,
  });
  assert.equal(isolation.markerKey, "live_role_matrix_isolated:1");
  assert.match(isolation.databaseIdentity.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(isolation.batchNonceSha256, hashValue(BATCH_NONCE));
  assert.throws(
    () =>
      assertIsolationMarker(db, 1, {
        batchNonce: "wrong-batch-nonce-0001",
        databasePath: currentDbPath,
      }),
    /batch nonce|拒绝写入/u,
  );
  const baseMarker = JSON.parse(
    db
      .prepare("SELECT value FROM sys_config WHERE key='live_role_matrix_isolated:1'")
      .get().value,
  );
  for (const mutate of [
    (marker) => {
      marker.issuedAt = new Date(Date.now() + 60_000).toISOString();
    },
    (marker) => {
      marker.expiresAt = new Date(Date.now() - 1).toISOString();
    },
    (marker) => {
      marker.unexpected = true;
    },
  ]) {
    const marker = structuredClone(baseMarker);
    mutate(marker);
    db.prepare("UPDATE sys_config SET value=? WHERE key='live_role_matrix_isolated:1'").run(
      JSON.stringify(marker),
    );
    assert.throws(() =>
      assertIsolationMarker(db, 1, {
        batchNonce: BATCH_NONCE,
        databasePath: currentDbPath,
      }),
    );
  }
  db.prepare("UPDATE sys_config SET value=? WHERE key='live_role_matrix_isolated:1'").run(
    JSON.stringify(baseMarker),
  );
  db.exec(
    "INSERT INTO users VALUES(4,NULL,'null-tenant','x','空租户','staff','启用',2,NULL,NULL)",
  );
  assert.throws(
    () =>
      assertIsolationMarker(db, 1, {
        batchNonce: BATCH_NONCE,
        databasePath: currentDbPath,
      }),
    /空租户数据/u,
  );
  db.exec("DELETE FROM users WHERE id=4");
  db.exec("INSERT INTO tenants VALUES(2,'其他租户','已开通','live',1,'x')");
  assert.throws(
    () =>
      assertIsolationMarker(db, 1, {
        batchNonce: BATCH_NONCE,
        databasePath: currentDbPath,
      }),
    /唯一测试租户/u,
  );
});

test("真实云运行就绪必须同时满足环境密钥、官方HTTPS域名与新鲜显式验证", () => {
  const now = Date.now();
  const payload = {
    generatedAt: new Date(now).toISOString(),
    channels: [
      {
        key: "ai",
        verification: "passed",
        verified: true,
        effective: "connected",
        details: {
          provider: "yunwu",
          keySource: "environment",
          baseUrl: "https://yunwu.ai/v1",
          configFingerprint: "9".repeat(64),
          executionMode: "external_provider",
        },
        lastCheck: {
          outcome: "passed",
          checkedAt: new Date(now - 1_000).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        },
      },
    ],
  };
  const accepted = assertFreshOfficialYunwuReadiness(payload, { now });
  assert.equal(accepted.officialEndpoint, true);
  assert.match(accepted.fingerprint, /^[a-f0-9]{64}$/u);
  assert.match(accepted.verificationFingerprint, /^[a-f0-9]{64}$/u);
  const reverifiedPayload = structuredClone(payload);
  reverifiedPayload.channels[0].lastCheck.checkedAt = new Date(now - 500).toISOString();
  reverifiedPayload.channels[0].lastCheck.expiresAt = new Date(now + 120_000).toISOString();
  const reverified = assertFreshOfficialYunwuReadiness(reverifiedPayload, { now });
  assert.equal(reverified.fingerprint, accepted.fingerprint);
  assert.notEqual(
    reverified.verificationFingerprint,
    accepted.verificationFingerprint,
  );
  const rotatedConfigPayload = structuredClone(payload);
  rotatedConfigPayload.channels[0].details.configFingerprint = "8".repeat(64);
  const rotated = assertFreshOfficialYunwuReadiness(rotatedConfigPayload, { now });
  assert.notEqual(rotated.fingerprint, accepted.fingerprint);
  for (const mutate of [
    (copy) => (copy.channels[0].details.keySource = "database"),
    (copy) => (copy.channels[0].details.baseUrl = "https://api.bltcy.ai/v1"),
    (copy) => (copy.channels[0].verification = "stale"),
    (copy) => (copy.channels[0].lastCheck.expiresAt = new Date(now - 1).toISOString()),
  ]) {
    const copy = structuredClone(payload);
    mutate(copy);
    assert.throws(() => assertFreshOfficialYunwuReadiness(copy, { now }));
  }
});

function profilePermissionFixture({ full, review, content }) {
  return {
    canDispatch: true,
    canReviewRuns: review,
    canViewInternalProfile: full,
    canViewCapabilities: full,
    canViewSkills: full,
    canViewPrompt: full,
    canViewWorkMethod: full,
    canViewWorkConfig: full,
    canViewJobProfile: full,
    canViewRuntimeBindings: full,
    canEditPrompt: full,
    canEditConfig: full,
    canEditSkills: full,
    ...(content ? { canViewFullPrompt: full } : {}),
  };
}

function profileFixture(domain, lane) {
  const full = lane === "boss";
  const content = domain === "content";
  const boundary = "仅老板可查看完整内部档案";
  const permissions = profilePermissionFixture({
    full,
    review: lane !== "employee",
    content,
  });
  if (!full) {
    return {
      identity: content
        ? {
            idx: 8,
            key: "distribution",
            person: "派火",
            name: "分发官",
            group: "内容生产部",
            moduleGroup: "内容生产部",
            positionSkill: null,
            emoji: "📣",
            color: "#000",
            duty: "形成分发包",
            intro: "分发岗位",
            optional: false,
            title: "分发官",
            department: "内容生产部",
            status: "可派活",
          }
        : {
            idx: 106,
            key: "unit-economics",
            person: "经营分析师",
            name: "单店模型官",
            position: "单店模型官",
            duty: "测算盈亏",
            description: "重算门店模型",
            intro: "提供真实输入",
            emoji: "📊",
            extension: false,
            specialistId: 106,
            department: {
              id: 1,
              code: "M-01",
              name: "战略部",
              emoji: "🧭",
              color: "#111",
            },
          },
      capabilities: [],
      workMethod: { redacted: true, boundary },
      skillLibrary: content
        ? {
            required: [],
            historical: [],
            custom: [],
            customSkills: [],
            redacted: true,
            boundary,
          }
        : {
            required: [],
            optional: [],
            learned: [],
            enabled: [],
            redacted: true,
            boundary,
          },
      prompts: content
        ? {
            defaultTemplate: null,
            effectiveTemplate: null,
            overrideTemplate: null,
            systemPrompt: { template: null },
            pipelinePrompt: {},
            soloPrompt: {},
            redacted: true,
            boundary,
          }
        : {
            defaultTemplate: null,
            override: null,
            overrideTemplate: null,
            effectiveTemplate: null,
            overrideMode: "append_only",
            redacted: true,
            boundary,
          },
      workConfig: { redacted: true, boundary },
      jobProfile: { redacted: true, boundary },
      runtimeBindings: { redacted: true, boundary },
      runtime: {},
      dispatch: content
        ? {
            endpoint: "/api/employee-workbench/content/8/dispatch",
            taskTypes: ["分发包"],
            types: ["分发包"],
            defaultTaskType: "分发包",
            defaultType: "分发包",
            available: true,
            enabled: true,
            snapshotNotice: "服务端锁定完整档案",
            form: {},
            guidance: {},
            approval: {},
            handoff: {},
          }
        : {
            endpoint: "/api/employee-workbench/restaurant/106/dispatch",
            taskTypes: ["执行方案"],
            types: ["执行方案"],
            defaultTaskType: "执行方案",
            defaultType: "执行方案",
            requirementMaxChars: 8000,
            selectedSpecialistId: 106,
            requiredInputs: ["经营数据"],
            guidance: {},
            available: true,
            enabled: true,
            snapshotNotice: "服务端锁定完整档案",
          },
      permissions,
      provenance: { redacted: true, boundary },
    };
  }
  if (!content) {
    const editableConfig = {
      textModel: null,
      visionModel: null,
      webMode: "allowed",
      knowledgeScopes: ["餐饮产业知识库"],
      outputLength: "full",
      timeoutSeconds: 900,
      approvalMode: "owner_review",
      maxCost: null,
      language: "zh-CN",
    };
    const requiredSkill = {
      id: "required:unit-economics",
      title: "完整岗位 Skill",
      detail: "测算单店模型",
      instructions: "按完整岗位手册执行",
      source: "restaurant.json",
      version: "1",
      origin: "catalog_required",
      required: true,
      enabled: true,
      locked: true,
    };
    return {
      identity: {
        idx: 106,
        key: "unit-economics",
        person: "经营分析师",
        name: "单店模型官",
        position: "单店模型官",
        duty: "测算盈亏",
        description: "重算门店模型",
        intro: "提供真实输入",
        emoji: "📊",
        extension: false,
        specialistId: 106,
        department: { id: 1, code: "M-01", name: "战略部", emoji: "🧭", color: "#111" },
      },
      capabilities: [
        {
          id: "unit-economics:capability:01",
          name: "盈亏测算",
          description: "按真实数据重算",
          order: 1,
          required: true,
          enabled: true,
          locked: true,
          source: "restaurant.json",
        },
      ],
      workMethod: {
        requiredInputs: ["营业额"],
        steps: ["核验输入"],
        deliverables: ["盈亏模型"],
        qualityGates: ["数字可复算"],
        safetyBoundaries: ["不得补造"],
        safetyBoundarySource: "岗位手册",
        manualMarkdown: "# 完整岗位手册",
      },
      skillLibrary: {
        required: [requiredSkill],
        optional: [],
        learned: [],
        enabled: [requiredSkill],
        catalogStatus: "loaded",
        catalogHash: "a".repeat(64),
      },
      prompts: {
        defaultTemplate: "出厂完整提示词-abcdefghijklmnop",
        override: null,
        overrideTemplate: null,
        effectiveTemplate: "有效完整提示词-abcdefghijklmnop",
        hash: "b".repeat(64),
        effectiveHash: "b".repeat(64),
        revision: 0,
        overrideMode: "append_only",
        redacted: false,
        boundary: "只可追加",
      },
      workConfig: {
        ...editableConfig,
        tenantScoped: true,
        fields: [{ key: "textModel" }],
        values: editableConfig,
        version: "restaurant-config-r0",
        boundary: "配置不削弱能力",
      },
      jobProfile: {
        employeeNumber: 106,
        roleKey: "unit-economics",
        roleTitle: "单店模型官",
        department: "战略部",
        moduleGroup: "战略部",
        positionSkill: "完整岗位 Skill",
        duty: "测算盈亏",
        intro: "岗位说明",
        scope: "restaurant_single_employee",
        responsibilities: ["测算盈亏"],
        useCases: ["重算单店模型"],
        nonGoals: ["不得补造"],
        requiredInputs: ["营业额"],
        expectedDeliverables: ["盈亏模型"],
        qualityStandards: ["数字可复算"],
        safetyBoundaries: ["不得补造"],
        kpis: ["通过质量门"],
        authority: { mayDraft: true },
        serviceLevel: { timeoutSeconds: 900 },
        outputContract: { contractId: "restaurant" },
        outputSchema: { type: "object" },
        primaryArtifact: "markdown",
        validOutputFixture: {},
        collaborators: ["运营部"],
        completedRuns: 0,
        profileVersion: "restaurant-v2-fixture",
        source: "server/catalog/restaurant.json",
        sourceVersion: "restaurant-v2-fixture",
        boundaries: ["不得补造"],
      },
      runtimeBindings: {
        work: { mode: "single_employee_dispatch", handler: "marshalWork" },
        models: { text: { route: "tenant_text_model_route" } },
        webPolicy: { defaultMode: "required", cadence: "every_dispatch", evidenceRequired: true },
        apis: [{ id: "text_generation", binding: "tenant_text_model_route" }],
        tools: [{ id: "web_search", binding: "employeeWebSearch" }],
        connectors: [{ kind: "model_generation", handler: "marshalWork" }],
      },
      runtime: {
        status: "空闲",
        runs: 0,
        completedRuns: 0,
        reviewPendingRuns: 0,
        reconciliationPendingRuns: 0,
        runningTasks: 0,
        recentTasks: [],
        taskPage: { offset: 0, limit: 8, total: 0, hasMore: false, nextOffset: null },
        lastTask: null,
      },
      dispatch: {
        endpoint: "/api/employee-workbench/restaurant/106/dispatch",
        taskTypes: ["执行方案"],
        types: ["执行方案"],
        defaultTaskType: "执行方案",
        defaultType: "执行方案",
        requirementMaxChars: 8000,
        selectedSpecialistId: 106,
        requiredInputs: ["营业额"],
        guidance: { intro: "单店模型专项" },
        available: true,
        enabled: true,
        lockedCapabilityCount: 1,
        snapshotNotice: "派活锁定完整档案",
      },
      permissions,
      provenance: {
        employeeIdx: 106,
        catalog: "server/catalog/restaurant.json",
        catalogHash: "c".repeat(64),
        manualHash: "d".repeat(64),
        profileVersion: "restaurant-v2-fixture",
        skillsCatalog: "loaded",
        skillsCatalogHash: "a".repeat(64),
        skillsVerificationLevel: "fixture",
        skillsEffectValidation: "fixture",
        tenantId: 1,
        noSilentFallback: true,
      },
    };
  }
  const contentRequired = {
    title: "分发官完整岗位 Skill",
    detail: "形成平台分发包",
    source: "content-catalog",
    required: true,
    enabled: true,
    locked: true,
  };
  return {
    identity: {
      idx: 8,
      key: "distribution",
      person: "派火",
      name: "分发官",
      group: "内容生产部",
      moduleGroup: "内容生产部",
      positionSkill: "分发官完整岗位 Skill",
      emoji: "📣",
      color: "#000",
      duty: "形成分发包",
      intro: "内容分发岗位",
      optional: false,
      title: "分发官",
      department: "内容生产部",
      status: "可派活",
    },
    capabilities: [{ name: "分发", emoji: "📣", desc: "形成平台包", required: true, enabled: true, locked: true }],
    workMethod: {
      inputs: ["已审内容"],
      steps: ["形成分发包"],
      deliverables: ["平台发布包"],
      approval: "老板审核",
      qualityGate: "人工终审",
      handoff: "老板",
      executionBoundary: "不执行外发",
      raw: { input: {}, execution: {}, output: {}, approval: {}, handoff: {} },
    },
    skillLibrary: {
      required: [contentRequired],
      historical: [{ title: "历史分发技能", locked: true }],
      custom: [],
      customSkills: [],
      boundary: "核心技能锁定",
    },
    prompts: {
      defaultTemplate: "出厂完整提示词-abcdefghijklmnop",
      overrideTemplate: "",
      effectiveSummary: "出厂岗位提示词",
      effectiveTemplate: "有效完整提示词-abcdefghijklmnop",
      systemPrompt: { template: "系统岗位模板" },
      pipelinePrompt: { template: "流水线模板" },
      soloPrompt: { template: "单岗位模板" },
      placeholders: [],
      interpolationPolicy: {},
      finalOutputContract: { format: "json", outputKeys: ["publish_packages"], contract: "完整字段", primaryArtifact: "publish_packages", block: "只输出JSON" },
      hash: "e".repeat(64),
      effectiveHash: "e".repeat(64),
      revision: 0,
      version: "content-8-r0",
      redacted: false,
      boundary: "只可追加",
    },
    workConfig: {
      fields: [{ key: "textModel" }],
      values: { textModel: "", imageModel: "", outputLength: "std", approvalMode: "岗位默认", timeoutSeconds: 300 },
      factoryDefault: { common: {} },
      safeLegacyConfig: {},
      enterpriseOverrides: {},
      version: "r0",
      mode: "factory_plus_tenant_overlay",
      summary: "完整出厂配置",
      boundary: "不削弱核心能力",
    },
    jobProfile: {
      employeeNumber: 8,
      roleKey: "distribution",
      roleTitle: "分发官",
      department: "内容生产部",
      moduleGroup: "内容生产部",
      positionSkill: "分发官完整岗位 Skill",
      duty: "形成分发包",
      intro: "内容分发岗位",
      responsibilities: ["形成分发包"],
      useCases: ["单岗位交付"],
      scope: "single_station",
      requiredInputs: ["已审内容"],
      expectedDeliverables: ["平台发布包"],
      qualityStandards: ["人工终审"],
      safetyBoundaries: ["不执行外发"],
      boundaries: ["不执行外发"],
      nonGoals: ["不自动发布"],
      collaborators: ["老板"],
      outputKeys: ["publish_packages"],
      outputSchema: { type: "object" },
      connectorPolicy: { connectors: [] },
      serviceLevel: { approval: {} },
      authority: { mayDraft: true },
      group: "内容生产部",
      source: "content-crew.json",
      sourceVersion: "v1",
      profileVersion: "content-8-r0",
    },
    runtimeBindings: {
      work: { mode: "single_station", handler: "compileContentEmployeeSoloPrompt" },
      models: { text: { route: "tenant_text_model_route" } },
      webPolicy: { defaultMode: "allowed", cadence: "when_task_requires" },
      apis: [{ id: "text_generation", binding: "tenant_text_model_route" }],
      tools: [{ id: "publish", binding: "executeContentConnector" }],
      connectors: [{ kind: "publish", handler: "executeContentConnector" }],
    },
    runtime: {
      status: "可派活",
      runs: 0,
      completedRuns: 0,
      reviewPendingRuns: 0,
      reconciliationPendingRuns: 0,
      runningTasks: 0,
      failedRuns: 0,
      remediatedRuns: 0,
      lastRunAt: null,
      lastTask: null,
      recentTasks: [],
    },
    dispatch: {
      endpoint: "/api/employee-workbench/content/8/dispatch",
      taskTypes: ["分发包"],
      types: ["分发包"],
      defaultTaskType: "分发包",
      defaultType: "分发包",
      available: true,
      enabled: true,
      lockedCapabilityCount: 1,
      snapshotNotice: "派活锁定完整档案",
      form: {},
      guidance: {},
      approval: {},
      handoff: {},
    },
    permissions,
    provenance: {
      authority: "权威目录",
      source: "content-crew.json",
      sourceVersion: "v1",
      referenceSha256: "f".repeat(64),
      skillsCatalogHash: "a".repeat(64),
      profileVersion: "content-8-r0",
      updatedAt: null,
      executionMode: "single_user",
      tenantId: 1,
      noSilentFallback: true,
      boundary: "新项目独立写入",
    },
  };
}

test("两类工作台都对老板展示完整档案，对管理层/员工服务端脱敏且拒绝修改权限", () => {
  for (const domain of ["restaurant", "content"]) {
    const result = assertProfileAccessMatrix({
      domain,
      boss: profileFixture(domain, "boss"),
      management: profileFixture(domain, "management"),
      employee: profileFixture(domain, "employee"),
    });
    assert.equal(result.samples.length, 3);
    const broken = profileFixture(domain, "management");
    broken.permissions.canEditPrompt = true;
    assert.throws(
      () =>
        assertProfileAccessMatrix({
          domain,
          boss: profileFixture(domain, "boss"),
          management: broken,
          employee: profileFixture(domain, "employee"),
        }),
      /canEditPrompt/u,
    );
    for (const field of [
      "workMethod",
      "skillLibrary",
      "prompts",
      "workConfig",
      "jobProfile",
      "provenance",
    ]) {
      const leaked = profileFixture(domain, "management");
      leaked[field].internalLeak = "private-profile-value";
      assert.throws(() =>
        assertProfileAccessMatrix({
          domain,
          boss: profileFixture(domain, "boss"),
          management: leaked,
          employee: profileFixture(domain, "employee"),
        }),
      );
    }
    for (const field of [
      "capabilities",
      "workMethod",
      "skillLibrary",
      "workConfig",
      "jobProfile",
      "provenance",
    ]) {
      const incomplete = profileFixture(domain, "boss");
      incomplete[field] = Array.isArray(incomplete[field]) ? [] : {};
      assert.throws(() =>
        assertProfileAccessMatrix({
          domain,
          boss: incomplete,
          management: profileFixture(domain, "management"),
          employee: profileFixture(domain, "employee"),
        }),
      );
    }
  }
});

test("内容采纳前门禁拒绝伪造snapshot任务要求，权威row未通过时不会进入adopt", () => {
  const row = {
    title: "权威任务标题",
    requirement: "任务唯一标识：LIVE-authority-contract\n必须形成完整分发包",
  };
  let adoptCalls = 0;
  const gateThenAdopt = (snapshot) => {
    const authority = assertContentDispatchSnapshotMatchesAuthority(snapshot, row);
    adoptCalls += 1;
    return authority;
  };
  assert.throws(
    () =>
      gateThenAdopt({
        dispatch: {
          title: row.title,
          requirement: "任务唯一标识：LIVE-authority-contract\n只交一个空框架即可",
        },
      }),
    /requirement与权威/u,
  );
  assert.throws(
    () =>
      gateThenAdopt({
        dispatch: { title: "伪造标题", requirement: row.requirement },
      }),
    /title与权威/u,
  );
  assert.equal(adoptCalls, 0);
  assert.deepEqual(
    gateThenAdopt({
      dispatch: {
        title: row.title,
        requirement: row.requirement,
        feedback: "事实准确优先",
      },
    }),
    { ...row, feedback: "事实准确优先" },
  );
  assert.equal(adoptCalls, 1);
});

function populateSuccessfulFlow(database) {
  database.exec(`
    INSERT INTO tasks VALUES(11,1,'parent','数据','已完成',2,1,NULL,'真实穿刺','t','t','');
    INSERT INTO tasks VALUES(12,1,'child','数据','已完成',3,2,11,'任务拆解','t','t','');
    INSERT INTO task_submissions VALUES(21,1,12,3,'private result','驳回',NULL,NULL,2,'t','t');
    INSERT INTO task_submissions VALUES(22,1,12,3,'private result','通过',NULL,NULL,2,'t','t');
    INSERT INTO task_submissions VALUES(23,1,11,2,'private summary','通过',NULL,NULL,1,'t','t');
    INSERT INTO agent_tasks(
      id,tenant_id,marshal_id,specialist_id,title,type,status,output_id,created_by,
      requirement,employee_web_snapshot,created_at
    ) VALUES(31,1,1,106,'restaurant','执行方案','已完成',41,2,'requirement','private snapshot','t');
    INSERT INTO content_employee_runs(
      id,tenant_id,employee_idx,employee_key,employee_name,employee_group,title,type,status,
      requirement,ai_mode,model,snapshot_json,created_by,created_at,updated_at
    ) VALUES(32,1,8,'distribution','分发官','内容生产部','content','发布包','已完成','requirement','api','gpt','private snapshot',3,'t','t');
    INSERT INTO credit_logs VALUES(51,1,2,'restaurant','text','gpt',100,50,0.1,3,9997,'api','private note','t');
    INSERT INTO credit_logs VALUES(52,1,3,'content','text','gpt',120,60,0.2,4,9993,'api','private note','t');
    INSERT INTO credit_holds VALUES(61,1,2,51,'restaurant','text','gpt',10,3,'settled','agent_task',31,'t','t');
    INSERT INTO credit_holds VALUES(62,1,3,52,'content','text','gpt',10,4,'settled','content_employee_run',32,'t','t');
    INSERT INTO contents VALUES(41,1,'执行方案','restaurant output','private body','可使用','api',2,1,NULL,NULL,NULL,'t');
    INSERT INTO contents VALUES(42,1,'平台发布包','content output','private body','可使用','api',3,NULL,8,'content_employee_run',32,'t');
    INSERT INTO approvals VALUES(71,1,'content',41,'review','private summary','已通过',2,1,'boss',NULL,'t','t');
    INSERT INTO approvals VALUES(72,1,'content',42,'review','private summary','已通过',3,1,'boss',NULL,'t','t');
    INSERT INTO materials VALUES(81,1,'material','岗位产物','content_employee_run',32,3,'private material','t');
    INSERT INTO biz_assets VALUES(91,1,'restaurant asset','内容资产','使用中','content',41,2,'private note','t');
    INSERT INTO biz_assets VALUES(92,1,'content asset','内容资产','使用中','content',42,3,'private note','t');
    INSERT INTO kb_docs VALUES(101,1,'数字员工','knowledge','private kb','content',41,1,1,'t');
    INSERT INTO notifications VALUES(111,1,2,'task','new task','parent','/execution',0,'t');
    INSERT INTO notifications VALUES(112,1,3,'task','new task','child','/execution',0,'t');
    INSERT INTO notifications VALUES(113,1,2,'marshal','restaurant done','done','/employees?employee=106&task=31',0,'t');
    INSERT INTO notifications VALUES(114,1,3,'content','content done','done','/content',0,'t');
    INSERT INTO op_logs VALUES(121,1,1,'老板','经营执行','新建任务','parent','127.0.0.1','t');
    INSERT INTO op_logs VALUES(122,1,2,'经理','经营执行','拆解下级任务','child / parent#11','127.0.0.1','t');
    INSERT INTO op_logs VALUES(123,1,2,'经理','经营执行','人工验收通过','task#12:ok','127.0.0.1','t');
    INSERT INTO op_logs VALUES(124,1,1,'老板','经营执行','人工验收通过','task#11:ok','127.0.0.1','t');
    INSERT INTO op_logs VALUES(125,1,2,'经理','餐饮数字员工','派发任务','restaurant','127.0.0.1','t');
    INSERT INTO op_logs VALUES(126,1,3,'员工','内容生产仓','派发内容员工任务','distribution:run#32:content','127.0.0.1','t');
    INSERT INTO op_logs VALUES(127,1,1,'老板','餐饮数字员工','采纳产出','content#41','127.0.0.1','t');
    INSERT INTO op_logs VALUES(128,1,1,'老板','内容生产仓','采纳内容员工产出并入素材库','run#32/material#81/content#42；未执行外发','127.0.0.1','t');
    UPDATE tenants SET credits=9993 WHERE id=1;
  `);
}

test("水位与流向证据只保留正向字段且覆盖账务审批资产知识通知操作日志", () => {
  const watermarks = captureWatermarks(db, 1);
  populateSuccessfulFlow(db);
  const evidence = collectFlowEvidence(db, 1, watermarks);
  assert.equal(evidence.manualTask.tasks.length, 2);
  assert.equal(evidence.manualTask.submissions.length, 3);
  assert.equal(evidence.billing.holds.length, 2);
  assert.equal(evidence.billing.inputTokens, 220);
  assert.equal(evidence.billing.outputTokens, 110);
  assert.equal(evidence.billing.chargedCredits, 7);
  assert.equal(evidence.billing.balanceDelta, -7);
  assert.equal(evidence.approvals.length, 2);
  assert.equal(evidence.assets.length, 2);
  assert.equal(evidence.knowledge.length, 1);
  assert.equal(evidence.materials.length, 1);
  assert.equal(evidence.notifications.length, 4);
  assert.equal(evidence.operations.length, 8);
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(
    serialized,
    /private body|private result|private snapshot/u,
  );
  assert.doesNotMatch(
    serialized,
    /private note|private kb|private notification/u,
  );
});

test("最终流向校验接受完整闭环并拒绝缺失驳回、悬挂占扣和零token", () => {
  const watermarks = captureWatermarks(db, 1);
  populateSuccessfulFlow(db);
  const evidence = collectFlowEvidence(db, 1, watermarks);
  const ids = {
    parentTaskId: 11,
    childTaskId: 12,
    restaurantTaskId: 31,
    contentRunId: 32,
  };
  assert.deepEqual(validateFinalFlowEvidence(evidence, ids), {
    ok: true,
    errors: [],
  });
  const broken = structuredClone(evidence);
  broken.manualTask.submissions = broken.manualTask.submissions.filter(
    (row) => row.result !== "驳回",
  );
  broken.billing.holds[0].status = "held";
  broken.billing.heldCount = 1;
  broken.billing.inputTokens = 0;
  const result = validateFinalFlowEvidence(broken, ids);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("驳回记录")));
  assert.ok(result.errors.some((item) => item.includes("未结算占扣")));
  assert.ok(result.errors.some((item) => item.includes("输入token")));
});

test("强流向校验把任务、提交、审批、素材、资产、知识和日志绑定本次业务ID与角色ID", () => {
  const watermarks = captureWatermarks(db, 1);
  populateSuccessfulFlow(db);
  const evidence = collectFlowEvidence(db, 1, watermarks);
  const ids = {
    parentTaskId: 11,
    childTaskId: 12,
    restaurantTaskId: 31,
    restaurantSpecialistId: 106,
    restaurantOutputId: 41,
    restaurantKnowledgeId: 101,
    restaurantAssetId: 91,
    contentRunId: 32,
    contentEmployeeIdx: 8,
    contentMaterialId: 81,
    contentId: 42,
  };
  const actors = {
    boss: { id: 1 },
    management: { id: 2 },
    employee: { id: 3 },
  };
  assert.deepEqual(validateBoundFlowEvidence(evidence, ids, actors), {
    ok: true,
    errors: [],
  });
  const broken = structuredClone(evidence);
  broken.approvals.find((row) => row.target_id === 42).reviewer_id = 2;
  broken.assets.find((row) => row.source_id === 41).creator_id = 3;
  broken.operations = broken.operations.filter((row) => row.action !== "采纳产出");
  const result = validateBoundFlowEvidence(broken, ids, actors);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("内容审批")));
  assert.ok(result.errors.some((item) => item.includes("餐饮业务资产")));
  assert.ok(result.errors.some((item) => item.includes("餐饮采纳操作日志")));
});

test("汇总只把显式ok=true记为通过并统计403边界", () => {
  assert.deepEqual(
    summarizeRunChecks([
      { ok: true, status: 200 },
      { ok: true, status: 403 },
      { ok: false, status: 500 },
      {},
    ]),
    { count: 4, passed: 2, failed: 2, forbiddenChecks: 1 },
  );
});

test("checkpoint只能在batch、库身份、代码、场景和输出目标全部一致时恢复", () => {
  const identity = computeDatabaseIdentityFingerprint(
    db,
    currentDbPath,
    "live-role-fixture-database-0001",
  );
  const code = computeFilesFingerprint([
    path.join(projectRoot, "scripts/lib/live-role-flow-matrix.mjs"),
  ]).sha256;
  const scenario = computeScenarioFingerprint({ contentIdx: 8 });
  const outputPath = `${currentDbPath}.final.json`;
  const checkpoint = {
    schema: LIVE_ROLE_FLOW_CHECKPOINT_SCHEMA,
    status: "interrupted",
    outputPath,
    batchNonceSha256: hashValue(BATCH_NONCE),
    databaseIdentitySha256: identity.sha256,
    codeFingerprint: code,
    scenarioFingerprint: scenario,
    actorIds: { boss: 1, management: 2, employee: 3 },
    providerFingerprint: "a".repeat(64),
    ids: { restaurantTaskId: 31 },
    stages: { restaurant_dispatched: { completed: true } },
  };
  assert.equal(
    validateCheckpoint(checkpoint, {
      batchNonceSha256: hashValue(BATCH_NONCE),
      databaseIdentitySha256: identity.sha256,
      codeFingerprint: code,
      scenarioFingerprint: scenario,
      outputPath,
    }),
    checkpoint,
  );
  for (const key of [
    "batchNonceSha256",
    "databaseIdentitySha256",
    "codeFingerprint",
    "scenarioFingerprint",
  ]) {
    const broken = { ...checkpoint, [key]: "0".repeat(64) };
    assert.throws(() =>
      validateCheckpoint(broken, {
        batchNonceSha256: hashValue(BATCH_NONCE),
        databaseIdentitySha256: identity.sha256,
        codeFingerprint: code,
        scenarioFingerprint: scenario,
        outputPath,
      }),
    );
  }
  for (const broken of [
    { ...checkpoint, actorIds: {} },
    {
      ...checkpoint,
      actorIds: { boss: 1, management: 1, employee: 3 },
    },
    { ...checkpoint, providerFingerprint: "not-a-fingerprint" },
  ]) {
    assert.throws(() =>
      validateCheckpoint(broken, {
        batchNonceSha256: hashValue(BATCH_NONCE),
        databaseIdentitySha256: identity.sha256,
        codeFingerprint: code,
        scenarioFingerprint: scenario,
        outputPath,
      }),
    );
  }
});

test("运行起止指纹能发现关键代码和数据库schema在长任务中途变化", () => {
  const dependency = path.join(
    os.tmpdir(),
    `live-role-dependency-${process.pid}-${Date.now()}.js`,
  );
  temporaryPaths.push(dependency);
  fs.writeFileSync(dependency, "export const revision = 1;\n", "utf8");
  const codeBefore = computeFilesFingerprint([dependency]).sha256;
  fs.writeFileSync(dependency, "export const revision = 2;\n", "utf8");
  const codeAfter = computeFilesFingerprint([dependency]).sha256;
  assert.notEqual(codeAfter, codeBefore);

  const databaseBefore = computeDatabaseIdentityFingerprint(
    db,
    currentDbPath,
    "live-role-fixture-database-0001",
  );
  db.exec("ALTER TABLE unrelated_global ADD COLUMN fingerprint_change TEXT");
  const databaseAfter = computeDatabaseIdentityFingerprint(
    db,
    currentDbPath,
    "live-role-fixture-database-0001",
  );
  assert.notEqual(databaseAfter.sha256, databaseBefore.sha256);
  assert.notEqual(databaseAfter.schemaSha256, databaseBefore.schemaSha256);
});

test("resume预守卫二次失败仍保留原三角色身份，替换同租户账号会在任何收费提交前拒绝", () => {
  const outputPath = `${currentDbPath}.resume-output.json`;
  const checkpointPath = `${currentDbPath}.resume-checkpoint.json`;
  temporaryPaths.push(outputPath, checkpointPath);
  const codeFiles = [
    runnerPath,
    path.join(projectRoot, "scripts/lib/live-role-flow-matrix.mjs"),
    path.join(projectRoot, "scripts/lib/real-employee-matrix.mjs"),
    path.join(projectRoot, "scripts/lib/employee-output-quality-audit.mjs"),
    ...recursivelyListCodeDependencyFiles(path.join(projectRoot, "server/src")),
    ...recursivelyListCodeDependencyFiles(path.join(projectRoot, "server/catalog")),
  ];
  const databaseIdentity = computeDatabaseIdentityFingerprint(
    db,
    currentDbPath,
    "live-role-fixture-database-0001",
  );
  const checkpoint = {
    schema: LIVE_ROLE_FLOW_CHECKPOINT_SCHEMA,
    status: "interrupted",
    updatedAt: new Date().toISOString(),
    outputPath,
    batchNonceSha256: hashValue(BATCH_NONCE),
    databaseIdentitySha256: databaseIdentity.sha256,
    codeFingerprint: computeFilesFingerprint(codeFiles).sha256,
    scenarioFingerprint: computeScenarioFingerprint({
      plan: LIVE_ROLE_FLOW_PLAN,
      restaurantIdx: 106,
      contentIdx: 8,
      flow: "human-rework+restaurant-adopt+content-adopt",
      revision: 2,
    }),
    tenantId: 1,
    actorIds: { boss: 1, management: 2, employee: 3 },
    watermarks: {},
    ids: {},
    stages: {},
    providerFingerprint: null,
  };
  writeJsonExclusive0600(checkpointPath, checkpoint);
  const runResume = (credentials) =>
    spawnSync(
      process.execPath,
      [
        runnerPath,
        "--credentials-stdin",
        "--allow-ai-cloud",
        "--db",
        currentDbPath,
        "--batch-nonce",
        BATCH_NONCE,
        "--base-url",
        "http://127.0.0.1:9",
        "--out",
        outputPath,
        "--resume",
        checkpointPath,
      ],
      { input: JSON.stringify(credentials), encoding: "utf8" },
    );
  const originalCredentials = {
    boss: { username: "boss", password: "unused-boss" },
    management: { username: "manager", password: "unused-manager" },
    employee: { username: "employee", password: "unused-employee" },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failed = runResume(originalCredentials);
    assert.notEqual(failed.status, 0);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(checkpointPath, "utf8")).actorIds,
      checkpoint.actorIds,
    );
    assert.equal(fs.existsSync(outputPath), false);
  }

  db.exec(`
    INSERT INTO users VALUES(4,1,'manager-alt','x','另一经理','ops_director','启用',1,NULL,NULL);
    INSERT INTO users VALUES(5,1,'employee-alt','x','另一员工','sales','启用',4,NULL,NULL);
  `);
  const swapped = runResume({
    boss: originalCredentials.boss,
    management: { username: "manager-alt", password: "unused" },
    employee: { username: "employee-alt", password: "unused" },
  });
  assert.notEqual(swapped.status, 0);
  assert.match(swapped.stderr, /三角色身份/u);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(checkpointPath, "utf8")).actorIds,
    checkpoint.actorIds,
  );
  assert.equal(
    Number(
      db.prepare("SELECT COUNT(*) count FROM credit_holds").get().count,
    ),
    0,
  );
});

test("SIGINT实际中断子进程返回130并写安全checkpoint，resume不产生任何业务POST", async () => {
  let resolveHealthHit = null;
  let businessPosts = 0;
  const server = http.createServer((request) => {
    if (request.method === "POST") businessPosts += 1;
    if (request.url === "/api/health") {
      resolveHealthHit?.();
      resolveHealthHit = null;
    }
    // Intentionally keep the response open until the child handles SIGINT.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const outputPath = `${currentDbPath}.sigint-output.json`;
  const checkpointPath = `${currentDbPath}.sigint-checkpoint.json`;
  temporaryPaths.push(outputPath, checkpointPath);
  const credentials = {
    boss: { username: "boss", password: "unused-boss" },
    management: { username: "manager", password: "unused-manager" },
    employee: { username: "employee", password: "unused-employee" },
  };
  const run = async ({ resume }) => {
    const healthHit = new Promise((resolve) => {
      resolveHealthHit = resolve;
    });
    const args = [
      runnerPath,
      "--credentials-stdin",
      "--allow-ai-cloud",
      "--db",
      currentDbPath,
      "--batch-nonce",
      BATCH_NONCE,
      "--base-url",
      `http://127.0.0.1:${server.address().port}`,
      "--out",
      outputPath,
      ...(resume
        ? ["--resume", checkpointPath]
        : ["--checkpoint", checkpointPath]),
    ];
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(JSON.stringify(credentials));
    const exit = once(child, "exit");
    let timeout;
    try {
      await Promise.race([
        healthHit,
        exit.then(([code, signal]) => {
          throw new Error(
            `子进程在health故障注入前退出：code=${code} signal=${signal || "none"}`,
          );
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("等待子进程health请求超时")),
            5_000,
          );
        }),
      ]);
    } catch (error) {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    child.kill("SIGINT");
    const [code, signal] = await exit;
    assert.equal(code, 130);
    assert.equal(signal, null);
    return JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  };
  try {
    const first = await run({ resume: false });
    assert.equal(first.status, "interrupted");
    assert.deepEqual(first.actorIds, { boss: 1, management: 2, employee: 3 });
    assert.equal(fs.existsSync(outputPath), false);
    const second = await run({ resume: true });
    assert.equal(second.status, "interrupted");
    assert.deepEqual(second.actorIds, first.actorIds);
    assert.equal(businessPosts, 0);
    assert.deepEqual(second.ids, {});
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("nonce变更在未知HTTP结果后回读唯一业务记录，重试不会再提交", async () => {
  const rows = [];
  let submits = 0;
  const first = await reconcileNonceMutation({
    label: "paid mutation",
    lookup: async () => rows,
    mutate: async () => {
      submits += 1;
      rows.push({ id: 9, nonce: BATCH_NONCE });
      throw new Error("socket closed after commit");
    },
    validate: (row) => assert.equal(row.nonce, BATCH_NONCE),
  });
  assert.equal(first.recoveredAfterUnknownOutcome, true);
  const resumed = await reconcileNonceMutation({
    label: "paid mutation",
    lookup: async () => rows,
    mutate: async () => {
      submits += 1;
    },
  });
  assert.equal(resumed.reconciled, true);
  assert.equal(submits, 1);
  rows.push({ id: 10, nonce: BATCH_NONCE });
  await assert.rejects(
    () =>
      reconcileNonceMutation({
        label: "paid mutation",
        lookup: async () => rows,
        mutate: async () => {},
      }),
    /多条记录/u,
  );
});

test("收费AI恢复按首行精确nonce、角色、岗位和watermark唯一找回，不被同标题旧批次混淆", () => {
  const recoveryDb = new DatabaseSync(":memory:");
  try {
    recoveryDb.exec(`
      CREATE TABLE agent_tasks(
        id INTEGER PRIMARY KEY,tenant_id INTEGER,created_by INTEGER,
        specialist_id INTEGER,status TEXT,title TEXT,requirement TEXT
      );
      CREATE TABLE content_employee_runs(
        id INTEGER PRIMARY KEY,tenant_id INTEGER,created_by INTEGER,
        employee_idx INTEGER,status TEXT,title TEXT,requirement TEXT
      );
    `);
    const restaurantMarker = "任务唯一标识：LIVE-Case_Sensitive-restaurant-106";
    const contentMarker = "任务唯一标识：LIVE-Case_Sensitive-content-8";
    const insertRestaurant = recoveryDb.prepare(
      "INSERT INTO agent_tasks VALUES(?,?,?,?,?,?,?)",
    );
    insertRestaurant.run(1, 1, 2, 106, "已完成", "相同标题", `${restaurantMarker.toLowerCase()}\n旧批次`);
    insertRestaurant.run(2, 1, 2, 106, "生成中", "相同标题", `${restaurantMarker}\n本批次`);
    insertRestaurant.run(3, 1, 9, 106, "生成中", "相同标题", `${restaurantMarker}\n其他创建人`);
    const restaurant = findUniqueNonceBoundAiState(recoveryDb, {
      domain: "restaurant",
      tenantId: 1,
      actorId: 2,
      requirementMarker: restaurantMarker,
      minimumIdExclusive: 1,
    });
    assert.equal(restaurant.id, 2);
    assert.equal(restaurant.specialist_id, 106);

    const insertContent = recoveryDb.prepare(
      "INSERT INTO content_employee_runs VALUES(?,?,?,?,?,?,?)",
    );
    insertContent.run(10, 1, 3, 7, "已完成", "相同标题", `${contentMarker}\n错误岗位`);
    insertContent.run(11, 1, 3, 8, "生成中", "相同标题", `${contentMarker}\n本批次`);
    const content = findUniqueNonceBoundAiState(recoveryDb, {
      domain: "content",
      tenantId: 1,
      actorId: 3,
      employeeIdx: 8,
      requirementMarker: contentMarker,
      minimumIdExclusive: 9,
    });
    assert.equal(content.id, 11);
    recoveryDb
      .prepare("INSERT INTO content_employee_runs VALUES(?,?,?,?,?,?,?)")
      .run(12, 1, 3, 8, "生成中", "相同标题", `${contentMarker}\n重复批次`);
    assert.throws(
      () =>
        findUniqueNonceBoundAiState(recoveryDb, {
          domain: "content",
          tenantId: 1,
          actorId: 3,
          employeeIdx: 8,
          requirementMarker: contentMarker,
          minimumIdExclusive: 9,
        }),
      /多条/u,
    );
  } finally {
    recoveryDb.close();
  }
});

test("CLI源代码强制云AI显式opt-in、stdin凭据、loopback、同源禁跳转与独占0600证据", () => {
  const source = fs.readFileSync(runnerPath, "utf8");
  const library = fs.readFileSync(
    path.join(projectRoot, "scripts/lib/live-role-flow-matrix.mjs"),
    "utf8",
  );
  assert.match(source, /--allow-ai-cloud/u);
  assert.match(source, /--credentials-stdin/u);
  assert.match(source, /process\.stdin\.isTTY/u);
  assert.match(source, /isLoopbackBaseUrl/u);
  assert.match(source, /assertIsolationMarker/u);
  assert.match(library, /redirect:\s*"error"/u);
  assert.match(source, /fetchSameOriginNoRedirect/u);
  assert.match(source, /AbortSignal\.any/u);
  assert.match(library, /fs\.openSync\(temporary,\s*"wx",\s*0o600\)/u);
  assert.match(library, /fs\.linkSync\(temporary,\s*outputPath\)/u);
  assert.match(library, /fs\.chmodSync\(outputPath,\s*0o600\)/u);
  assert.doesNotMatch(
    source,
    /process\.env\.[A-Z0-9_]*(?:PASSWORD|API_KEY|TOKEN)/u,
  );
  assert.doesNotMatch(source, /--(?:password|api-key|token)\b/u);
});

test("CLI源代码覆盖三类真实HTTP业务、本地持久化403边界、恢复和独立契约门", () => {
  const source = fs.readFileSync(runnerPath, "utf8");
  for (const route of [
    "/api/execution/tasks",
    "/api/employee-workbench/restaurant/",
    "/api/marshals/tasks/",
    "/api/marshals/outputs/",
    "/api/employee-workbench/content/",
    "/api/sys/runtime-readiness",
  ]) {
    assert.ok(source.includes(route), `missing live route ${route}`);
  }
  for (const label of [
    "employee_cannot_dispatch_upward",
    "management_cannot_execute_for_employee",
    "employee_cannot_review_own_submission",
    "management_cannot_review_own_parent_submission",
    "employee_cannot_review_restaurant_output",
    "employee_cannot_self_review_content_output",
  ]) {
    assert.ok(source.includes(label), `missing forbidden scenario ${label}`);
  }
  assert.match(source, /capturePersistentSideEffectBoundary/u);
  assert.match(source, /assertForbiddenPersistentBoundaryUnchanged/u);
  assert.match(source, /assertLoginWritesReachedBoundDatabase/u);
  assert.match(source, /assertFreshOfficialYunwuReadiness/u);
  assert.match(source, /reconcileNonceMutation/u);
  assert.match(source, /SIGINT/u);
  assert.match(source, /validateCheckpoint/u);
  assert.match(source, /assertRestaurantContractFromDb/u);
  assert.match(source, /assertContentContractFromDb/u);
  assert.match(source, /assertProfileAccessMatrix/u);
  assert.doesNotMatch(source, /realCloudValidated/u);
});

test("CLI不会把登录令牌或HTTP原始响应送入证据对象", () => {
  const source = fs.readFileSync(runnerPath, "utf8");
  const artifactSource = source.slice(source.indexOf("const artifact ="));
  assert.doesNotMatch(artifactSource, /\.token\b/u);
  assert.doesNotMatch(artifactSource, /credentials/u);
  assert.doesNotMatch(artifactSource, /payload/u);
  assert.match(artifactSource, /positiveWhitelistEvidence/u);
});

test("npm脚本暴露live runner但不预置密码或云密钥", () => {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assert.equal(
    pkg.scripts["test:roles:live"],
    "node scripts/run-live-role-flow-matrix.mjs",
  );
  assert.doesNotMatch(pkg.scripts["test:roles:live"], /password|key|token/iu);
});
