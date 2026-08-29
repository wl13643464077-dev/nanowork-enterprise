/**
 * Valhalla 等时圈适配隔离测试。
 *
 * 只使用本文件内的 fetch/provider mock，不访问公网、不读取密钥。生产实现
 * 必须把四种交通方式和 10/20/30 分钟真实路网边界带入岗位证据；缺任一
 * 必需模式时，requireIsochrones 质量门必须失败，而不能退回固定半径。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(os.tmpdir(), `nanowork-location-isochrone-provider-${process.pid}.db`);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.NANOWORK_HTTP_USER_AGENT = 'NanoWorkEnterprise/1.0 (isochrone-provider-test)';
const previousValhallaEndpoint = process.env.NANOWORK_VALHALLA_ISOCHRONE_ENDPOINT;
process.env.NANOWORK_VALHALLA_ISOCHRONE_ENDPOINT = 'https://valhalla1.openstreetmap.de/isochrone';

const { initSchema, migrateV2 } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { buildEmployeeExecutionProfile } = await import('../src/employee-workbench.js');
const { marshalWork, parseTaskIsochroneRequest } = await import('../src/engines/ai.js');
const {
  collectLocationIntelligence,
  fetchValhallaIsochrones,
} = await import('../src/engines/location-intelligence.js');

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const MODES = Object.freeze(['walking', 'cycling', 'driving', 'transit']);
const MINUTES = Object.freeze([10, 20, 30]);
const COSTING = Object.freeze({
  walking: 'pedestrian',
  cycling: 'bicycle',
  driving: 'auto',
  transit: 'multimodal',
});

function polygonFor(mode, minutes) {
  const offset = 0.0008 + (MODES.indexOf(mode) + minutes / 10) * 0.0001;
  return {
    type: 'Polygon',
    coordinates: [[
      [112.55 - offset, 37.81 - offset],
      [112.55 + offset, 37.81 - offset],
      [112.55 + offset, 37.81 + offset],
      [112.55 - offset, 37.81 + offset],
      [112.55 - offset, 37.81 - offset],
    ]],
  };
}

function isochroneFixture({ modes = MODES, minutes = MINUTES } = {}) {
  return {
    provider: 'mock-routing-provider',
    source: 'https://valhalla1.openstreetmap.de/isochrone',
    isochrones: modes.flatMap(mode => minutes.map(value => ({
      mode,
      minutes: Number(value),
      polygon: polygonFor(mode, Number(value)),
      provider: 'mock-routing-provider',
      source: `https://valhalla1.openstreetmap.de/isochrone/${mode}/${value}`,
    }))),
  };
}

test('完整任务中的显式模式时长只请求对应真实等时圈，未写时长保留默认矩阵', async () => {
  assert.deepEqual(
    parseTaskIsochroneRequest({
      title: '太原吾悦广场商圈画像',
      requirement: '请核验步行15分钟、骑行20分钟、驾车30分钟范围，公交不设定时长。',
    }),
    {
      modes: ['walking', 'cycling', 'driving'],
      minutes: [15, 20, 30],
      modeMinutes: { walking: [15], cycling: [20], driving: [30] },
      source: 'task_explicit',
    },
  );
  assert.deepEqual(
    parseTaskIsochroneRequest({ title: '无时长的商圈画像', requirement: '只核验地点。' }),
    {
      modes: [...MODES],
      minutes: [...MINUTES],
      modeMinutes: null,
      source: 'default',
    },
  );

  const providerRequests = [];
  const result = await collectLocationIntelligence('毛血旺 太原吾悦广场', {
    fetchImpl: mapFetchFixture(),
    isochroneModes: ['walking', 'cycling', 'driving'],
    isochroneMinutes: [15, 20, 30],
    isochroneModeMinutes: {
      walking: [15],
      cycling: [20],
      driving: [30],
    },
    isochroneProvider: async (request) => {
      providerRequests.push(structuredClone(request));
      const mappings = request.modeMinutes || Object.fromEntries(
        request.modes.map((mode) => [mode, request.minutes]),
      );
      return {
        provider: 'mock-routing-provider',
        source: 'https://valhalla1.openstreetmap.de/isochrone',
        isochrones: Object.entries(mappings).flatMap(([mode, values]) =>
          values.map((value) => ({
            mode,
            minutes: Number(value),
            polygon: polygonFor(mode, Number(value)),
            provider: 'mock-routing-provider',
            source: `https://valhalla1.openstreetmap.de/isochrone/${mode}/${value}`,
          })),
        ),
      };
    },
  });
  assert.deepEqual(providerRequests, [{
    lat: 37.81,
    lon: 112.55,
    modes: ['walking', 'cycling', 'driving'],
    minutes: [15, 20, 30],
    modeMinutes: { walking: [15], cycling: [20], driving: [30] },
  }]);
  assert.equal(result.ok, true);
  assert.equal(result.evidence.isochroneComplete, true);
  assert.deepEqual(
    result.evidence.isochrones.map((zone) => `${zone.mode}:${zone.minutes}`),
    ['walking:15', 'cycling:20', 'driving:30'],
  );
  assert.deepEqual(result.evidence.isochroneModeMinutes, {
    walking: [15], cycling: [20], driving: [30],
  });
});

function mapFetchFixture() {
  return async input => {
    const url = new URL(String(input));
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
    throw new Error(`unexpected map URL in isolated provider test: ${url}`);
  };
}

test('默认 Valhalla provider 为四种模式请求 pedestrian/bicycle/auto/multimodal，并返回10/20/30分钟polygon', async () => {
  const requests = [];
  const result = await fetchValhallaIsochrones({
    lat: 37.81,
    lon: 112.55,
    fetchImpl: async input => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'valhalla1.openstreetmap.de');
      assert.equal(url.pathname, '/isochrone');
      const payload = JSON.parse(url.searchParams.get('json'));
      requests.push(payload);
      return {
        ok: true,
        async json() {
          return {
            type: 'FeatureCollection',
            features: payload.contours.map(({ time }) => ({
              type: 'Feature',
              properties: { contour: time },
              geometry: polygonFor(payload.costing === 'pedestrian' ? 'walking'
                : payload.costing === 'bicycle' ? 'cycling'
                  : payload.costing === 'auto' ? 'driving' : 'transit', time),
            })),
          };
        },
      };
    },
    timeoutMs: 100,
  });

  assert.equal(requests.length, MODES.length);
  assert.deepEqual(
    requests.map(request => request.costing).sort(),
    Object.values(COSTING).sort(),
  );
  for (const request of requests) {
    assert.deepEqual(request.contours.map(item => item.time), [...MINUTES]);
    assert.equal(request.polygons, true);
    assert.deepEqual(request.locations, [{ lat: 37.81, lon: 112.55 }]);
  }

  assert.equal(result.externalCall, true);
  assert.equal(result.provider, 'Valhalla (OpenStreetMap routing graph)');
  assert.deepEqual(result.modes, [...MODES]);
  assert.deepEqual(result.minutes, [...MINUTES]);
  assert.equal(result.isochrones.length, MODES.length * MINUTES.length);
  assert.deepEqual(
    [...new Set(result.isochrones.map(zone => zone.mode))].sort(),
    [...MODES].sort(),
  );
  for (const zone of result.isochrones) {
    assert.ok(MODES.includes(zone.mode));
    assert.ok(MINUTES.includes(zone.minutes));
    assert.equal(zone.polygon.type, 'Polygon');
    assert.equal(zone.provider, 'Valhalla (OpenStreetMap routing graph)');
    assert.match(zone.source, /^https:\/\/valhalla1\.openstreetmap\.de\/isochrone\?json=/u);
  }
});

test('requireIsochrones 缺任一交通模式时 collectLocationIntelligence 必须失败', async () => {
  for (const missingMode of MODES) {
    const requested = MODES.filter(mode => mode !== missingMode);
    const result = await collectLocationIntelligence('毛血旺 太原吾悦广场', {
      fetchImpl: mapFetchFixture(),
      timeoutMs: 100,
      requireIsochrones: true,
      isochroneProvider: ({ modes, minutes }) => isochroneFixture({
        modes: modes.filter(mode => mode !== missingMode),
        minutes,
      }),
    });

    assert.equal(result.ok, false, `缺少${missingMode}时不得通过等时圈质量门`);
    assert.equal(result.evidence.isochroneComplete, false);
    assert.ok(result.evidence.isochroneError.includes(`${missingMode}:10`));
    assert.deepEqual(
      [...new Set(result.evidence.isochrones.map(zone => zone.mode))].sort(),
      [...requested].sort(),
    );
  }
});

test('marshalWork 强制要求四模式等时圈：摘要进prompt，polygon只留employee_web_snapshot证据', async () => {
  const profile = buildEmployeeExecutionProfile(102, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const marshal = {
    code: 'M-01',
    name: '市场与选址分部',
    title: '内部调度容器',
    duty: '仅负责调度',
    skills: '',
    prompt: '',
    kb_deps: '',
  };
  const task = {
    title: '毛血旺 太原吾悦广场',
    type: '商圈画像',
    requirement: '核验竞品、客群与四种交通方式时间等时圈，形成可执行结论。',
  };
  const fixture = structuredClone(profile.outputContract.validFixture);
  fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
  fixture.decision_context.sources[0].source = '通用网页补充·毛血旺太原｜https://search.test/restaurant-context';
  for (const item of Object.values(fixture.input_audit || {}))
    item.evidence_refs = [fixture.decision_context.sources[0].source];
  for (const item of Object.values(fixture.method_execution || {}))
    item.evidence_refs = [fixture.decision_context.sources[0].source];
  const generated = [];
  let locationOptions = null;

  const output = await marshalWork(marshal, task, 'boss', {
    employeeExecution: profile,
    requireAgenticResearch: true,
    webSearchFn: async () => ({
      attempted: true,
      ok: true,
      provider: 'mock-search',
      results: [{
        title: '通用网页补充·毛血旺太原',
        url: 'https://search.test/restaurant-context',
        snippet: '隔离测试公开网页摘要。',
      }],
    }),
    agenticWebResearchFn: async () => ({
      attempted: true,
      ok: true,
      candidateReady: true,
      provider: 'mock-agentic-search',
      results: Array.from({ length: 5 }, (_, index) => ({
        title: `Agentic隔离来源${index + 1}`,
        url: `https://agentic.test/source-${index + 1}`,
        snippet: `公开来源${index + 1}`,
      })),
      fetchCandidates: Array.from({ length: 5 }, (_, index) => ({
        title: `Agentic隔离来源${index + 1}`,
        url: `https://agentic.test/source-${index + 1}`,
        snippet: `公开来源${index + 1}`,
      })),
    }),
    controlledWebFetchFn: async sources => ({
      attempted: true,
      ok: true,
      provider: 'mock-controlled-fetch',
      results: [{
        title: '通用网页补充·毛血旺太原',
        url: sources[0]?.url || 'https://search.test/restaurant-context',
        snippet: '受控网页正文摘要。',
        body: '受控网页正文：太原吾悦广场毛血旺目标餐饮门店的菜单、菜品、价格、营业状态、评价与竞品公开信息已按核验日逐项抽取；本段只用于隔离等时圈链路验收，未知字段保留复核动作，不构成外部执行授权。',
      }],
      evidence: { externalCall: true, fetched: 1, ssrfProtected: true },
    }),
    locationIntelligenceFn: async (value, options = {}) => {
      locationOptions = options;
      return collectLocationIntelligence(value, {
        ...options,
        fetchImpl: mapFetchFixture(),
        timeoutMs: 100,
        isochroneProvider: ({ modes, minutes }) => isochroneFixture({ modes, minutes }),
      });
    },
    generateFn: async args => {
      generated.push(args);
      return {
        text: JSON.stringify(fixture),
        mode: 'api',
        model: 'yunwu-isochrone-test-model',
        usage: { inputTokens: 101, outputTokens: 17 },
      };
    },
  });

  assert.equal(locationOptions.requireIsochrones, true);
  assert.deepEqual(locationOptions.isochroneModes, [...MODES]);
  assert.deepEqual(locationOptions.isochroneMinutes, [...MINUTES]);
  assert.equal(output.employeeContract.valid, true);
  assert.equal(generated.length, 1);
  const prompt = generated[0].userMsg;
  for (const mode of MODES) assert.match(prompt, new RegExp(mode, 'u'));
  for (const minutes of MINUTES) assert.match(prompt, new RegExp(`${minutes}分钟`, 'u'));
  assert.match(prompt, /https:\/\/valhalla1\.openstreetmap\.de\/isochrone\/walking\/10/u);
  assert.doesNotMatch(prompt, /"coordinates"/u, 'polygon坐标不能膨胀进模型正文');
  assert.doesNotMatch(prompt, /112\.549/u, 'polygon坐标不能膨胀进模型正文');

  const locationChannel = output.web.channels.find(channel => channel.kind === 'location_intelligence');
  assert.ok(locationChannel);
  assert.equal(locationChannel.evidence.isochrones.length, MODES.length * MINUTES.length);
  assert.ok(locationChannel.evidence.isochrones.every(zone => zone.polygon?.type === 'Polygon'));
  assert.match(JSON.stringify(locationChannel.evidence), /"coordinates"/u);
});

after(() => {
  if (previousValhallaEndpoint === undefined) delete process.env.NANOWORK_VALHALLA_ISOCHRONE_ENDPOINT;
  else process.env.NANOWORK_VALHALLA_ISOCHRONE_ENDPOINT = previousValhallaEndpoint;
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
