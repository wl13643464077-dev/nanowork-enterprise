import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { prepareDataMigration } from "../../ops/deploy/prepare-data-migration.mjs";

function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString("hex")}`;
}
function matches(password, stored) {
  const [salt, hash] = stored.split(":");
  return crypto.timingSafeEqual(
    crypto.scryptSync(password, salt, 32),
    Buffer.from(hash, "hex"),
  );
}
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nw-migration-")),
  );
  const data = path.join(root, "source-data"),
    output = path.join(root, "private-copy");
  fs.mkdirSync(path.join(data, "uploads/files/1"), { recursive: true });
  const file = path.join(data, "uploads/files/1/photo.png");
  fs.writeFileSync(file, "fixture");
  const source = path.join(data, "source.db"),
    db = new DatabaseSync(source);
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,credits INTEGER);
    CREATE TABLE users(id INTEGER PRIMARY KEY,tenant_id INTEGER,username TEXT,role TEXT,password_hash TEXT,auth_version INTEGER);
    CREATE TABLE uploaded_files(id INTEGER PRIMARY KEY,tenant_id INTEGER,user_id INTEGER,file_path TEXT,file_url TEXT);
    CREATE TABLE contents(id INTEGER PRIMARY KEY,tenant_id INTEGER,body TEXT,snapshot_json TEXT);
    CREATE TABLE credit_logs(id INTEGER PRIMARY KEY,credits INTEGER,note TEXT);
    INSERT INTO tenants VALUES(1,175822);INSERT INTO credit_logs VALUES(1,-37,'保留历史账单');`);
  const preservedPassword = passwordHash("isolated-already-strong-pass");
  db.prepare("INSERT INTO users VALUES(1,1,?,?,?,3),(2,1,?,?,?,8)").run(
    "seed-boss",
    "boss",
    passwordHash("123456"),
    "real-admin",
    "admin",
    preservedPassword,
  );
  db.prepare("INSERT INTO uploaded_files VALUES(1,1,1,?,?)").run(
    file,
    "/uploads/files/1/photo.png",
  );
  db.prepare("INSERT INTO contents VALUES(1,1,?,?)").run(
    "全文和事实原样保留",
    JSON.stringify({ file, nested: JSON.stringify({ file }) }),
  );
  return {
    root,
    data,
    output,
    file,
    source,
    db,
    preservedPassword,
    cleanup() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("生产副本完整保留数据与余额，仅迁路径和确认匹配的种子密码，源DB不变", async () => {
  const f = fixture();
  try {
    f.db.exec(
      "PRAGMA journal_mode=WAL; INSERT INTO credit_logs VALUES(2,19,'尚未checkpoint的真实WAL行');",
    );
    const sourceBefore = fs.readFileSync(f.source);
    const originalUsers = f.db.prepare("SELECT * FROM users ORDER BY id").all();
    const report = await prepareDataMigration({
      source: f.source,
      sourceDataRoot: f.data,
      outputDir: f.output,
    });
    assert.equal(report.status, "ready", JSON.stringify(report.errors));
    assert.equal(report.preservedAllRowsAndOtherValues, true);
    assert.deepEqual(report.tenantBalances, [{ id: 1, credits: 175822 }]);
    assert.equal(report.changedPasswordCount, 1);
    assert.equal(report.verifiedLocalFileCount, 1);
    assert.deepEqual(fs.readFileSync(f.source), sourceBefore);
    assert.deepEqual(
      f.db.prepare("SELECT * FROM users ORDER BY id").all(),
      originalUsers,
    );
    const copy = new DatabaseSync(report.destination, { readOnly: true });
    try {
      const users = copy.prepare("SELECT * FROM users ORDER BY id").all();
      assert.equal(matches("123456", users[0].password_hash), false);
      assert.equal(users[0].auth_version, 4);
      assert.equal(users[1].password_hash, f.preservedPassword);
      assert.equal(users[1].auth_version, 8);
      const privateCredentials = fs.readFileSync(
        path.join(f.output, "credentials.txt"),
        "utf8",
      );
      const password = privateCredentials.match(/初始密码：([^\n]+)/)[1];
      assert.ok(password.length >= 24);
      assert.equal(matches(password, users[0].password_hash), true);
      assert.doesNotMatch(privateCredentials, /real-admin/);
      const content = copy.prepare("SELECT * FROM contents").get();
      assert.equal(content.body, "全文和事实原样保留");
      const snapshot = JSON.parse(content.snapshot_json);
      assert.equal(
        snapshot.file,
        "/var/lib/nanowork/data/uploads/files/1/photo.png",
      );
      assert.equal(JSON.parse(snapshot.nested).file, snapshot.file);
      assert.equal(
        copy.prepare("SELECT * FROM credit_logs").get().credits,
        -37,
      );
      assert.equal(
        copy.prepare("SELECT note FROM credit_logs WHERE id=2").get().note,
        "尚未checkpoint的真实WAL行",
      );
      assert.doesNotMatch(JSON.stringify(report), new RegExp(password));
      for (const name of [
        "nanowork-industry.db",
        "credentials.txt",
        "migration-report.json",
        "upload-manifest.json",
      ])
        assert.equal(
          fs.statSync(path.join(f.output, name)).mode & 0o777,
          0o600,
        );
      assert.equal(fs.statSync(f.output).mode & 0o777, 0o700);
    } finally {
      copy.close();
    }
    await assert.rejects(
      prepareDataMigration({
        source: f.source,
        sourceDataRoot: f.data,
        outputDir: f.output,
      }),
      /输出已存在/,
    );
  } finally {
    f.cleanup();
  }
});

test("缺失附件不猜路径、不重置账号，仍保留完整备份和明确阻塞报告", async () => {
  const f = fixture();
  try {
    fs.unlinkSync(f.file);
    const original = f.db
      .prepare("SELECT password_hash FROM users WHERE id=1")
      .get().password_hash;
    const report = await prepareDataMigration({
      source: f.source,
      sourceDataRoot: f.data,
      outputDir: f.output,
    });
    assert.equal(report.status, "blocked_missing_or_unsafe_files");
    assert.ok(report.errors.some((error) => error.code === "FILE_MISSING"));
    assert.equal(fs.existsSync(path.join(f.output, "credentials.txt")), false);
    const copy = new DatabaseSync(report.destination, { readOnly: true });
    try {
      assert.equal(
        copy.prepare("SELECT password_hash FROM users WHERE id=1").get()
          .password_hash,
        original,
      );
      assert.equal(
        copy.prepare("SELECT credits FROM tenants").get().credits,
        175822,
      );
    } finally {
      copy.close();
    }
  } finally {
    f.cleanup();
  }
});

test("跨租户附件和逃逸符号链接均阻断迁移，不把越权路径送到服务器", async () => {
  for (const mode of ["tenant", "symlink"]) {
    const f = fixture();
    try {
      if (mode === "tenant") f.db.exec("UPDATE uploaded_files SET tenant_id=2");
      else {
        fs.unlinkSync(f.file);
        const outside = path.join(f.root, "outside.png");
        fs.writeFileSync(outside, "outside");
        fs.symlinkSync(outside, f.file);
      }
      const report = await prepareDataMigration({
        source: f.source,
        sourceDataRoot: f.data,
        outputDir: f.output,
      });
      assert.equal(report.status, "blocked_missing_or_unsafe_files");
      assert.ok(
        report.errors.some(
          (error) =>
            error.code ===
            (mode === "tenant"
              ? "UPLOAD_OWNER_TENANT_MISMATCH"
              : "SYMLINK_OUTSIDE_DATA"),
        ),
      );
    } finally {
      f.cleanup();
    }
  }
});
