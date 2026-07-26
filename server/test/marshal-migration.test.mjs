import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DBP = path.join(os.tmpdir(), `shanmei-marshal-migration-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;

const { initSchema, migrateV2, q } = await import('../src/db.js');
initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,plan,credits) VALUES(2,'历史租户','已开通','标准版',0)`);
const userId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('legacy_chat_user','x','历史用户','sales','启用',2)`).lastInsertRowid;
const sessionId = q.run(`INSERT INTO marshal_chat_sessions(marshal_id,user_id,title,tenant_id) VALUES(1,?,'历史会话',1)`, userId).lastInsertRowid;
const messageId = q.run(`INSERT INTO marshal_chat_msgs(session_id,role,content,tenant_id) VALUES(?,'user','历史消息',1)`, sessionId).lastInsertRowid;

test('迁移会按会话所有者回填元帅历史的租户归属', () => {
  migrateV2();
  assert.equal(q.get('SELECT tenant_id FROM marshal_chat_sessions WHERE id=?', sessionId).tenant_id, 2);
  assert.equal(q.get('SELECT tenant_id FROM marshal_chat_msgs WHERE id=?', messageId).tenant_id, 2);
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
