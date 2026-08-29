/**
 * 102「竞品与商圈画像」等时圈红绿门。
 *
 * 这组测试故意只注入地图/路线供应商，不读取任何真实密钥、不访问公网。
 * 红门记录当前实现不能用固定 radiusMeters/直线距离冒充步行、骑行、驾车、
 * 公共交通时间等时圈；绿门同时约束真实派活的 prompt 和 employee_web_snapshot
 * 必须能看到这些证据。
 *
 * 约定的最小运行契约（供生产实现接入）：
 *   locationIntelligence(..., { isochroneProvider })
 *   -> evidence.isochrones[]，每项至少包含
 *      mode、minutes、polygon 或 boundary、provider、source。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DB_PATH = path.join(os.tmpdir(), `nanowork-location-isochrone-gate-${process.pid}.db`);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.NANOWORK_HTTP_USER_AGENT = 'NanoWorkEnterprise/1.0 (location-isochrone-gate)';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { buildEmployeeExecutionProfile } = await import('../src/employee-workbench.js');
const { marshalWork } = await import('../src/engines/ai.js');
const { collectLocationIntelligence } = await import('../src/engines/location-intelligence.js');
const marshalRoutes = (await import('../src/routes/marshals.js')).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const MODES = Object.freeze(['walking', 'cycling', 'driving', 'transit']);
const MINUTES = Object.freeze([10, 20, 30]);

function clone(value) {
  return structuredClone(value);
}

function isoZone(mode, minutes, index = 0) {
  const delta = 0.001 + (index * 0.0002);
  return {
    mode,
    minutes,
    polygon: {
      type: 'Polygon',
      coordinates: [[
        [112.55 - delta, 37.81 - delta],
        [112.55 + delta, 37.81 - delta],
        [112.55 + delta, 37.81 + delta],
        [112.55 - delta, 37.81 + delta],
        [112.55 - delta, 37.81 - delta],
      ]],
    },
    provider: 'mock-routing-provider',
    source: `https://routing.mock/isochrones/${mode}/${minutes}`,
  };
}

const ISOCHRONE_FIXTURE = MODES.flatMap((mode, modeIndex) => (
  MINUTES.map((minutes, minuteIndex) => isoZone(mode, minutes, modeIndex + minuteIndex))
));

/**
 * Geocoder/POI mock for collectLocationIntelligence. Any URL not explicitly
 * handled here throws, which keeps this test from accidentally touching network.
 */
function mapFetchMock(calls) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname === 'nominatim.openstreetmap.org') {
      return {
        ok: true,
        async json() {
          return [{
            osm_type: 'way',
            osm_id: 7020,
            lat: '37.810000',
            lon: '112.550000',
            display_name: '太原市小店区吾悦广场',
          }];
        },
      };
    }
    if (url.hostname === 'overpass-api.de') {
      return {
        ok: true,
        async json() {
          return {
            elements: [{
              type: 'node',
              id: 7021,
              lat: 37.8104,
              lon: 112.5504,
              tags: { name: '吾悦广场餐饮店', amenity: 'restaurant' },
            }],
          };
        },
      };
    }
    throw new Error(`unexpected map URL in isolated test: ${url}`);
  };
}

function isochroneProviderMock(calls) {
  return async (request = {}) => {
    calls.push(clone(request));
    const requestedModes = Array.isArray(request.modes)
      ? request.modes
      : request.mode ? [request.mode] : MODES;
    const requestedMinutes = Array.isArray(request.minutes)
      ? request.minutes
      : request.minutes == null ? MINUTES : [request.minutes];
    return {
      provider: 'mock-routing-provider',
      source: 'https://routing.mock/isochrones',
      isochrones: requestedModes.flatMap(mode => (
        requestedMinutes.map((minutes, index) => isoZone(mode, Number(minutes), index))
      )),
    };
  };
}

function task() {
  return {
    title: '毛血旺 太原吾悦广场',
    type: '商圈画像',
    requirement: '基于公开地图与商圈证据核验竞品、客群和交通可达性，形成可执行结论。',
  };
}

function locationEvidence() {
  return {
    attempted: true,
    ok: true,
    provider: 'mock-map + mock-routing-provider',
    results: [{
      // 地点锚点必须来自生产认可的地图主机；mock 自有域名仅是
      // metadata，不能通过来源质量门。
      title: 'OpenStreetMap定位·太原吾悦广场',
      url: 'https://www.openstreetmap.org/way/7020',
      // 刻意不把 mode/minutes 写在 snippet；如果 prompt 能看到它们，
      // 说明 marshalWork 传递了 channel.evidence，而不是碰巧回显搜索摘要。
      snippet: '地图已定位太原吾悦广场中心点；周边公开POI已完成核验。',
    }],
    evidence: {
      schemaVersion: 'nanowork.location-isochrone/1',
      externalCall: true,
      center: { displayName: '太原市小店区吾悦广场', lat: 37.81, lon: 112.55 },
      provider: 'mock-routing-provider',
      source: 'https://routing.mock/isochrones',
      isochrones: clone(ISOCHRONE_FIXTURE),
    },
  };
}

test('RED：员工102地图运行必须产出四种交通方式时间等时圈，而非固定半径', async () => {
  const mapCalls = [];
  const providerCalls = [];
  const result = await collectLocationIntelligence('毛血旺 太原吾悦广场', {
    fetchImpl: mapFetchMock(mapCalls),
    // 这是路线/等时圈供应商的隔离注入点；不需要也不允许猜测任何API密钥。
    isochroneProvider: isochroneProviderMock(providerCalls),
    timeoutMs: 100,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.ok(providerCalls.length >= 1, '必须调用可注入的等时圈供应商');
  assert.deepEqual(mapCalls.map(item => item.url.hostname), [
    'nominatim.openstreetmap.org',
    'overpass-api.de',
  ]);

  // 红门：当前生产实现没有 evidence.isochrones，只有 radiusMeters/直线距离，
  // 因而此断言在接入路线供应商前应明确失败，禁止悄悄把固定半径当等时圈。
  const zones = result.evidence?.isochrones;
  assert.ok(Array.isArray(zones) && zones.length >= MODES.length, '缺少时间等时圈证据');
  assert.deepEqual(
    [...new Set(zones.map(zone => zone.mode))].sort(),
    [...MODES].sort(),
    '步行、骑行、驾车、公共交通四种模式必须全部返回',
  );
  for (const zone of zones) {
    assert.ok(Number.isFinite(Number(zone.minutes)) && Number(zone.minutes) > 0, '等时圈必须有正数分钟');
    assert.ok(zone.polygon || zone.boundary, '等时圈必须有polygon或boundary，不能只有半径/直线距离');
    assert.equal(typeof zone.provider, 'string');
    assert.match(String(zone.source), /^https:\/\//u);
  }
});

test('GREEN：地图/等时圈证据必须进入员工102的marshalWork prompt与employee_web_snapshot', async () => {
  const tenantId = 1;
  const username = `location-isochrone-gate-${process.pid}`;
  q.run(
    `INSERT INTO tenants(id,name,status,plan,credits)
     VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100000`,
    tenantId,
    '等时圈隔离测试企业',
    '已开通',
    '标准版',
    100000,
  );
  const userId = Number(q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
     VALUES(?,?,?,?,?,?,?)`,
    username,
    'x',
    '等时圈测试老板',
    'boss',
    '启用',
    tenantId,
    100000,
  ).lastInsertRowid);

  const profile = runWithTenant(tenantId, () => buildEmployeeExecutionProfile(102, {
    tenantId,
    user: { id: userId, role: 'boss', tenant_id: tenantId },
  }));
  const specialistId = q.get('SELECT id FROM specialists WHERE employee_idx=102')?.id;
  const departmentId = q.get('SELECT id FROM marshals WHERE code=?', 'M-01')?.id;
  assert.ok(specialistId && departmentId, '隔离基线必须有员工102和M-01');

  const generatedCalls = [];
  const app = express();
  app.locals.employeeEstimateCallCredits = () => 1;
  app.locals.employeeWebSearch = async () => ({
    attempted: true,
    ok: true,
    provider: 'mock-search',
    results: [{
      title: 'Mock公开网页·吾悦广场餐饮',
      url: 'https://search.mock/restaurant',
      snippet: '用于隔离测试的公开网页摘要。',
    }],
  });
  app.locals.employeeAgenticWebResearch = async () => ({
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: 'mock-agentic-search',
    results: Array.from({ length: 5 }, (_, index) => ({
      title: `Mock agentic source ${index + 1}`,
      url: `https://agentic.mock/source-${index + 1}`,
      snippet: `公开来源${index + 1}`,
    })),
    fetchCandidates: Array.from({ length: 5 }, (_, index) => ({
      title: `Mock agentic source ${index + 1}`,
      url: `https://agentic.mock/source-${index + 1}`,
      snippet: `公开来源${index + 1}`,
    })),
    evidence: { qualityGate: { passed: true }, externalCall: true },
  });
  app.locals.employeeControlledWebFetch = async sources => ({
    attempted: true,
    ok: true,
    provider: 'mock-controlled-fetch',
    results: [{
      title: 'Mock受控网页正文',
      url: sources[0]?.url || 'https://search.mock/restaurant',
      snippet: '受控网页正文摘要。',
      body: '受控网页正文：毛血旺 太原吾悦广场目标餐饮门店的菜单、菜品、营业状态、价格、人均、评价与竞品信息仅用于隔离链路验收；未知字段保留可复核缺口，不构成真实业务事实。',
    }],
    evidence: { fetched: 1, externalCall: true, ssrfProtected: true },
  });
  app.locals.employeeLocationIntelligence = async () => locationEvidence();
  app.locals.employeeGenerate = async args => {
    generatedCalls.push(args);
    // 让路由收敛为失败快照，验证失败路径也不能丢地图/等时圈证据。
    return {
      text: '{"contract_id":"invalid-isochrone-gate"}',
      mode: 'api',
      model: 'mock-isochrone-model',
      usage: { inputTokens: 101, outputTokens: 17 },
    };
  };
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    req.user = { id: userId, name: '等时圈测试老板', role: 'boss', tenant_id: tenantId };
    runWithTenant(tenantId, () => next());
  });
  app.use('/marshals', marshalRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let taskId;
  try {
    const response = await fetch(`${base}/marshals/${departmentId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        specialistId,
        title: '毛血旺 太原吾悦广场',
        type: '分析',
        requirement: '核验竞品、客群与四种交通方式时间等时圈，形成可执行结论。',
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    taskId = Number(payload.taskId);
    assert.ok(taskId > 0);

    let row = null;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      row = runWithTenant(tenantId, () => q.get(
        'SELECT status,employee_web_snapshot FROM agent_tasks WHERE tenant_id=? AND id=?',
        tenantId,
        taskId,
      ));
      if (row?.status === '失败') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(row?.status, '失败');
    assert.ok(generatedCalls.length >= 1, '隔离模型至少应执行一次');

    const snapshot = JSON.parse(row.employee_web_snapshot);
    assert.equal(snapshot.kind, 'restaurant_employee_execution_evidence');
    const locationChannel = snapshot.web?.channels?.find(channel => channel.kind === 'location_intelligence');
    assert.ok(locationChannel, 'employee_web_snapshot必须保留location_intelligence通道');
    const snapshotZones = locationChannel.evidence?.isochrones;
    assert.ok(Array.isArray(snapshotZones) && snapshotZones.length >= MODES.length);
    assert.deepEqual(
      [...new Set(snapshotZones.map(zone => zone.mode))].sort(),
      [...MODES].sort(),
    );
    for (const zone of snapshotZones) {
      assert.ok(zone.polygon || zone.boundary);
      assert.ok(Number(zone.minutes) > 0);
      assert.equal(zone.provider, 'mock-routing-provider');
      assert.match(zone.source, /^https:\/\//u);
    }

    const prompt = generatedCalls[0].userMsg;
    // 生产实现当前只把 location.results 摘要放入prompt，这些模式不会出现，
    // 所以该断言会形成可定位的红门；接入后必须把 channel.evidence 一并注入。
    for (const mode of MODES) assert.match(prompt, new RegExp(mode, 'u'));
    assert.match(prompt, /10/u);
    assert.match(prompt, /https:\/\/routing\.mock\/isochrones/u);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (taskId) runWithTenant(tenantId, () => q.run('DELETE FROM agent_tasks WHERE tenant_id=? AND id=?', tenantId, taskId));
    runWithTenant(tenantId, () => q.run('DELETE FROM users WHERE id=?', userId));
  }
});

after(() => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
