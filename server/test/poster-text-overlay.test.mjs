import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { removeTempDbSafely, removeTempDirSafely } from './helpers/temp-db.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-poster-text-overlay-${process.pid}.db`);
const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-poster-text-uploads-'));
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* fresh test database */
  }
}

process.env.NANOWORK_DB = DBP;
process.env.NANOWORK_POSTER_TEXT_UPLOAD_ROOT = UPLOAD_ROOT;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';

const {
  buildOverlaySvg,
  detectImageFormat,
  fitTextLines,
  layoutPosterTextLayers,
  normalizePosterTextOverlay,
  renderPosterTextOverlay,
  renderSvgToPng,
  stripOverlayTextFromPrompt,
  POSTER_TEXT_NO_TEXT_DIRECTIVE,
} = await import('../src/engines/poster-text-overlay.js');
const { measureCjkText } = await import('../src/engines/cjk-font.js');
const { generateToolboxRun, TOOL_DEFINITIONS, validateToolRunPayload } = await import('../src/engines/toolbox.js');
const { compileContentEmployeeSoloPrompt } = await import('../src/engines/content-employee-workbench.js');
const { POSTER_TEXT_CAPABILITY } = await import('../src/engines/poster-text-capability.js');

// ---------- 图片供应商夹具：本地 OpenAI 兼容接口，返回一张纯色 PNG ----------
const nativeFetch = globalThis.fetch;
const providerCalls = [];
let fakeYunwuEnabled = false;
let basePngB64 = '';
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input || '');
  if (!fakeYunwuEnabled || !url.startsWith('http://yunwu.local/v1/')) {
    return nativeFetch(input, init);
  }
  const body = JSON.parse(String(init.body || '{}'));
  providerCalls.push({ url, body });
  if (url.endsWith('/images/generations')) {
    return new Response(
      JSON.stringify({
        data: [{ b64_json: basePngB64, mime_type: 'image/png' }],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
};

async function withFakeYunwu(fn) {
  const prevKey = process.env.YUNWU_API_KEY;
  const prevBase = process.env.YUNWU_BASE_URL;
  fakeYunwuEnabled = true;
  process.env.YUNWU_API_KEY = 'sk-local-poster-text-fixture';
  process.env.YUNWU_BASE_URL = 'http://yunwu.local/v1';
  try {
    return await fn();
  } finally {
    fakeYunwuEnabled = false;
    if (prevKey === undefined) delete process.env.YUNWU_API_KEY;
    else process.env.YUNWU_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.YUNWU_BASE_URL;
    else process.env.YUNWU_BASE_URL = prevBase;
  }
}

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const contentRoutes = (await import('../src/routes/content.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'叠字测试A店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
const bossId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id)
    VALUES('poster-boss','x','叠字老板','boss','老板办','启用',1)`,
  ).lastInsertRowid,
);
const boss = { id: bossId, name: '叠字老板', role: 'boss', tenant_id: 1 };

function appFor(user) {
  const app = express();
  app.use(express.json({ limit: '32mb' }));
  app.use((req, _res, next) =>
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    }),
  );
  app.use('/content', contentRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function post(base, route, body) {
  const response = await nativeFetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

const solidSvg = (w, h, color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${color}"/></svg>`;

const basePng = await renderSvgToPng(solidSvg(512, 640, '#d94f2b'), { width: 512, height: 640 });
basePngB64 = basePng.toString('base64');

after(async () => {
  await removeTempDbSafely(DBP);
  await removeTempDirSafely(UPLOAD_ROOT);
});

test('normalizePosterTextOverlay：校验角色/位置/长度并给出默认布局', () => {
  const normalized = normalizePosterTextOverlay({
    layers: [
      { text: '  招牌酸汤鱼  双人套餐 ', role: 'title' },
      { text: '¥99.9', role: 'price', position: 'center' },
      { text: '老王家酸汤鱼', role: 'store' },
      { text: '限时', role: 'badge', position: { x: 0.1, y: 0.1 }, align: 'left', maxWidth: 0.4 },
    ],
  });
  assert.equal(normalized.layers[0].text, '招牌酸汤鱼 双人套餐');
  assert.equal(normalized.layers[0].position, 'bottom');
  assert.equal(normalized.layers[2].position, 'bottom');
  assert.deepEqual(normalized.layers[3].position, { x: 0.1, y: 0.1 });
  assert.equal(normalized.layers[3].maxWidth, 0.4);
  assert.throws(() => normalizePosterTextOverlay({ layers: [] }), /至少需要一层/u);
  assert.throws(() => normalizePosterTextOverlay({ layers: [{ text: 'x', role: 'hero' }] }), /role 仅支持/u);
  assert.throws(() => normalizePosterTextOverlay({ layers: [{ text: '', role: 'title' }] }), /不能为空/u);
  assert.throws(() => normalizePosterTextOverlay({ layers: [{ text: '好'.repeat(61), role: 'title' }] }), /最多 60 字/u);
  assert.throws(() => normalizePosterTextOverlay({ layers: [{ text: 'x', position: 'left' }] }), /position 仅支持/u);
});

test('buildOverlaySvg：文字以矢量轮廓输出，原文只出现在转义后的 <desc> 中，不注入标签', () => {
  const hostile = '招牌<酸汤鱼> & "双人" \'套餐\'';
  const svg = buildOverlaySvg({
    canvas: { w: 600, h: 800 },
    layers: [
      { text: hostile, role: 'title', position: 'top' },
      { text: '¥168', role: 'price', position: 'center' },
      { text: '老王家酸汤鱼·朝阳店', role: 'store', position: 'bottom' },
    ],
  });
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('<desc>招牌&lt;酸汤鱼&gt; &amp; &quot;双人&quot; &#39;套餐&#39;</desc>'));
  assert.equal(svg.includes('<酸汤鱼>'), false);
  assert.match(svg, /data-role="title"/u);
  assert.match(svg, /data-role="price"/u);
  assert.match(svg, /data-role="store"/u);
  assert.ok((svg.match(/<path d="/gu) || []).length >= 20, '每个字都应转成 path 轮廓');
  assert.equal(svg.includes('<text'), false, '不得依赖 <text>（渲染环境无系统字体）');
  assert.equal(svg.includes('<image'), false);
  assert.equal(svg.includes('<script'), false);
});

test('fitTextLines：超宽先缩字号到下限，仍超宽则换行；行数超限继续缩小并保留全文', () => {
  const measure = (text, size) => [...text].length * size;
  const short = fitTextLines({ text: '酸汤鱼', maxWidth: 1000, maxFontSize: 80, minFontSize: 40, maxLines: 2, measure });
  assert.equal(short.fontSize, 80);
  assert.deepEqual(short.lines, ['酸汤鱼']);

  const shrink = fitTextLines({ text: '十个字的菜名要缩小字号', maxWidth: 600, maxFontSize: 80, minFontSize: 40, maxLines: 2, measure });
  assert.ok(shrink.fontSize < 80 && shrink.fontSize >= 40);
  assert.equal(shrink.lines.length, 1);

  const long = '这是一个非常非常长的菜名用来验证自动换行与缩放逻辑是否正确工作';
  const wrapped = fitTextLines({ text: long, maxWidth: 600, maxFontSize: 80, minFontSize: 40, maxLines: 2, measure });
  assert.equal(wrapped.wrapped, true);
  assert.ok(wrapped.lines.length <= 2);
  assert.equal(wrapped.lines.join(''), long, '换行不能丢字');
  assert.ok(wrapped.fontSize >= 12);

  const latin = fitTextLines({ text: 'Fresh Fish Daily 新鲜现杀', maxWidth: 400, maxFontSize: 60, minFontSize: 30, maxLines: 3, measure });
  assert.equal(latin.lines.join(' ').replace(/\s+/gu, ' '), 'Fresh Fish Daily 新鲜现杀');
  assert.ok(latin.lines.every(line => !/^\s|\s$/u.test(line)));
});

test('layoutPosterTextLayers：真实字体度量下长门店名换行且块不越界，价格按等宽数字排布', () => {
  const canvas = { w: 768, h: 1024 };
  const layout = layoutPosterTextLayers(
    normalizePosterTextOverlay({
      layers: [
        { text: '招牌酸汤鱼双人套餐', role: 'title', position: 'top' },
        { text: '¥99.9', role: 'price', position: 'center' },
        { text: '老王家酸汤鱼·朝阳大悦城店 每天10:00-22:00 欢迎光临 电话 010-88886666', role: 'store', position: 'bottom' },
      ],
    }).layers,
    canvas,
  );
  for (const block of layout.blocks) {
    assert.ok(block.x >= 0 && block.y >= 0, `${block.layer.role} 块坐标为负`);
    assert.ok(block.x + block.width <= canvas.w + 0.01, `${block.layer.role} 块超出右边界`);
    assert.ok(block.y + block.height <= canvas.h + 0.01, `${block.layer.role} 块超出下边界`);
  }
  const store = layout.blocks.find(block => block.layer.role === 'store');
  assert.equal(store.wrapped, true);
  assert.equal(
    store.lines.join('').replace(/\s/gu, ''),
    '老王家酸汤鱼·朝阳大悦城店每天10:00-22:00欢迎光临电话010-88886666',
    '换行不能丢字',
  );
  const title = layout.blocks.find(block => block.layer.role === 'title');
  assert.ok(title.fontSize > store.fontSize);
  // 等宽数字：11111 与 99999 在价格角色下宽度一致
  const w1 = measureCjkText('11111', 80, { weight: 900, monospaceDigits: true });
  const w9 = measureCjkText('99999', 80, { weight: 900, monospaceDigits: true });
  assert.equal(Math.round(w1), Math.round(w9));
  assert.equal(Math.round(w1), 5 * 0.6 * 80, '价格数字按 0.6em 固定单元格排布');
});

test('renderPosterTextOverlay：底图 + 三层文字渲染成同尺寸 PNG，且像素确实发生变化', async () => {
  const result = await renderPosterTextOverlay({
    imageBuffer: basePng,
    layers: [
      { text: '招牌酸汤鱼双人套餐', role: 'title', position: 'top' },
      { text: '¥99.9', role: 'price', position: 'center' },
      { text: '老王家酸汤鱼·朝阳店', role: 'store', position: 'bottom' },
    ],
  });
  assert.equal(result.width, 512);
  assert.equal(result.height, 640);
  const format = detectImageFormat(result.png);
  assert.equal(format.mime, 'image/png');
  assert.equal(format.width, 512);
  assert.equal(format.height, 640);
  assert.notEqual(result.png.toString('base64'), basePng.toString('base64'));
  assert.deepEqual(result.layers.map(layer => layer.role), ['title', 'price', 'store']);
  assert.equal(result.baseFormat.mime, 'image/png');

  const explicit = await renderPosterTextOverlay({
    imageBuffer: basePng,
    canvas: { w: 300, h: 300 },
    layers: [{ text: '门店名', role: 'store' }],
  });
  assert.equal(explicit.width, 300);
  assert.equal(explicit.height, 300);

  await assert.rejects(
    renderPosterTextOverlay({ imageBuffer: Buffer.from('not-an-image-at-all-really-not'), layers: [{ text: 'x', role: 'title' }] }),
    /PNG\/JPEG\/WebP/u,
  );
  await assert.rejects(
    renderPosterTextOverlay({ imageBuffer: basePng, layers: [{ text: '\u{1F35C}', role: 'title' }] }),
    /无法绘制的字符/u,
  );
});

test('stripOverlayTextFromPrompt：剥离用户文字与裸价格数字，并追加“无字”指令', () => {
  const prompt = '做一张海报，标题：招牌酸汤鱼双人套餐，价格 ¥99.9，门店名：老王家酸汤鱼，暖色调，真实商业摄影';
  const stripped = stripOverlayTextFromPrompt(prompt, [
    { text: '招牌酸汤鱼双人套餐' },
    { text: '¥99.9' },
    { text: '老王家酸汤鱼' },
  ]);
  assert.equal(stripped.includes('招牌酸汤鱼双人套餐'), false);
  assert.equal(stripped.includes('99.9'), false);
  assert.equal(stripped.includes('老王家酸汤鱼'), false);
  assert.ok(stripped.includes('暖色调'));
  assert.ok(stripped.includes('真实商业摄影'));
  assert.ok(stripped.includes(POSTER_TEXT_NO_TEXT_DIRECTIVE));
  assert.equal(stripped.includes('，，'), false);
});

test('generate-image 带 textOverlay：模型提示词不含用户文字，产物两张（成品 + 无字底图），计费两阶段结算不变', async () => {
  providerCalls.length = 0;
  const balanceBefore = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  const result = await withFakeYunwu(() =>
    withServer(boss, base =>
      post(base, '/content/generate-image', {
        prompt: '做一张海报，标题：招牌酸汤鱼双人套餐，价格 ¥99.9，门店名：老王家酸汤鱼，暖色调，真实商业摄影',
        size: '1024x1024',
        employeeIdx: 5,
        textOverlay: {
          layers: [
            { text: '招牌酸汤鱼双人套餐', role: 'title', position: 'top' },
            { text: '¥99.9', role: 'price', position: 'center' },
            { text: '老王家酸汤鱼', role: 'store', position: 'bottom' },
          ],
        },
      }),
    ),
  );
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.equal(providerCalls.length, 1, '叠字不额外调用模型');
  const sentPrompt = String(providerCalls[0].body.prompt);
  assert.equal(sentPrompt.includes('招牌酸汤鱼双人套餐'), false, '菜名不得进入模型提示词');
  assert.equal(sentPrompt.includes('99.9'), false, '价格不得进入模型提示词');
  assert.equal(sentPrompt.includes('老王家酸汤鱼'), false, '门店名不得进入模型提示词');
  assert.ok(sentPrompt.includes('画面不要出现任何文字'), '必须明确要求无字底图');
  assert.ok(sentPrompt.includes('暖色调'));

  assert.match(result.data.url, /^\/uploads\/poster-text\/1\/\d+-final\.png$/u);
  assert.match(result.data.baseImageUrl, /^\/uploads\/poster-text\/1\/\d+-base\.png$/u);
  assert.equal(result.data.textOverlay.applied, true);
  assert.equal(result.data.textOverlay.billed, false);
  assert.deepEqual(result.data.textOverlay.layers.map(layer => layer.text), ['招牌酸汤鱼双人套餐', '¥99.9', '老王家酸汤鱼']);
  assert.equal(result.data.billing.state, 'settled');
  assert.equal(result.data.visualPrompt.includes('招牌酸汤鱼双人套餐'), false);

  const finalPath = path.join(UPLOAD_ROOT, '1', path.basename(result.data.url));
  const basePath = path.join(UPLOAD_ROOT, '1', path.basename(result.data.baseImageUrl));
  assert.ok(fs.existsSync(finalPath), '成品未落盘');
  assert.ok(fs.existsSync(basePath), '无字底图未落盘');
  assert.equal(fs.readFileSync(basePath).toString('base64'), basePngB64, '底图必须原样保留供二次编辑');
  const finalFormat = detectImageFormat(fs.readFileSync(finalPath));
  assert.equal(finalFormat.mime, 'image/png');
  assert.equal(finalFormat.width, 512);
  assert.equal(finalFormat.height, 640);

  const job = q.get('SELECT * FROM media_jobs WHERE tenant_id=1 AND id=?', result.data.jobId);
  assert.equal(job.status, '成功');
  assert.equal(job.url, result.data.url);
  assert.equal(job.prompt.includes('招牌酸汤鱼双人套餐'), false, '任务记录里的模型描述也不含叠字文字');
  const snapshot = JSON.parse(job.snapshot_json);
  assert.equal(snapshot.textOverlay.baseImageUrl, result.data.baseImageUrl);
  assert.equal(snapshot.billing.state, 'settled');
  const balanceAfter = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  assert.equal(balanceBefore - balanceAfter, result.data.billing.chargedCredits, '只按供应商生图计费一次');
  assert.ok(result.data.billing.chargedCredits > 0);
});

test('generate-image 不带 textOverlay：行为不变（原始提示词进模型，产物为供应商 data URL，无底图副产物）', async () => {
  providerCalls.length = 0;
  const result = await withFakeYunwu(() =>
    withServer(boss, base =>
      post(base, '/content/generate-image', {
        prompt: '招牌酸汤鱼双人套餐 海报 暖色调',
        size: '1024x1024',
        employeeIdx: 5,
      }),
    ),
  );
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.equal(providerCalls.length, 1);
  assert.ok(String(providerCalls[0].body.prompt).includes('招牌酸汤鱼双人套餐'));
  assert.equal(String(providerCalls[0].body.prompt).includes(POSTER_TEXT_NO_TEXT_DIRECTIVE), false);
  assert.ok(result.data.url.startsWith('data:image/png;base64,'));
  assert.equal(result.data.baseImageUrl, undefined);
  assert.equal(result.data.textOverlay, undefined);
  assert.equal(result.data.visualPrompt, undefined);
  assert.equal(result.data.billing.state, 'settled');
  const job = q.get('SELECT * FROM media_jobs WHERE tenant_id=1 AND id=?', result.data.jobId);
  assert.equal(job.prompt, '招牌酸汤鱼双人套餐 海报 暖色调');
  assert.equal(JSON.parse(job.snapshot_json).textOverlay, undefined);
});

test('generate-image textOverlay 非法时 400 且不创建任务、不占扣', async () => {
  const jobsBefore = q.get('SELECT COUNT(*) n FROM media_jobs').n;
  const result = await withFakeYunwu(() =>
    withServer(boss, base =>
      post(base, '/content/generate-image', {
        prompt: '海报',
        employeeIdx: 5,
        textOverlay: { layers: [{ text: '菜名', role: 'hero' }] },
      }),
    ),
  );
  assert.equal(result.response.status, 400);
  assert.match(result.data.error, /role 仅支持/u);
  assert.equal(q.get('SELECT COUNT(*) n FROM media_jobs').n, jobsBefore);
});

test('工具箱产品图文：overlayTitle/Price/Store 三层叠字进入产物，供应商提示词要求无字', async () => {
  let captured;
  const payload = validateToolRunPayload({
    toolKey: 'shot',
    employeeIdx: 140,
    title: '酸汤鱼主图',
    inputs: {
      product: '双人酸汤鱼套餐',
      facts: '每日现杀活鱼，酸汤当天熬制',
      channels: ['朋友圈'],
      overlayTitle: '招牌酸汤鱼双人套餐',
      overlayPrice: '¥168',
      overlayStore: '老王家酸汤鱼·朝阳店',
    },
  });
  const result = await generateToolboxRun(TOOL_DEFINITIONS.shot, payload.inputs, {
    role: 'boss',
    mediaAvailableFn: () => true,
    generateImageFn: async args => {
      captured = args;
      return { model: 'offline-image-model', b64: basePngB64, mimeType: 'image/png' };
    },
  });
  assert.ok(captured.prompt.includes('画面不要出现任何文字'));
  const artifact = result.provenance.mediaArtifact;
  assert.equal(artifact.textOverlay.applied, true);
  assert.equal(artifact.textOverlay.billed, false);
  assert.deepEqual(artifact.textOverlay.layers.map(layer => layer.role), ['title', 'price', 'store']);
  assert.ok(artifact.url.startsWith('data:image/png;base64,'));
  const rendered = Buffer.from(artifact.url.slice('data:image/png;base64,'.length), 'base64');
  assert.notEqual(rendered.toString('base64'), basePngB64);
  assert.equal(detectImageFormat(rendered).width, 512);
  assert.match(result.resultMd, /精确叠字/u);
  assert.match(result.resultMd, /招牌酸汤鱼双人套餐/u);

  // 不填叠字字段：行为不变
  const plain = await generateToolboxRun(
    TOOL_DEFINITIONS.shot,
    validateToolRunPayload({
      toolKey: 'shot',
      employeeIdx: 140,
      title: '酸汤鱼主图',
      inputs: { product: '双人酸汤鱼套餐', facts: '每日现杀活鱼' },
    }).inputs,
    {
      role: 'boss',
      mediaAvailableFn: () => true,
      generateImageFn: async args => {
        captured = args;
        return { model: 'offline-image-model', url: 'https://cdn.example.test/shot.png', mimeType: 'image/png' };
      },
    },
  );
  assert.equal(captured.prompt.includes(POSTER_TEXT_NO_TEXT_DIRECTIVE), false);
  assert.equal(plain.provenance.mediaArtifact.url, 'https://cdn.example.test/shot.png');
  assert.equal(plain.provenance.mediaArtifact.textOverlay, undefined);
});

test('数字员工运行包：多媒体师(5)与品牌岗位(140/141)注入“海报文字精确叠加”说明，其他岗位不注入', async () => {
  const task = { direction: '做海报', industry: '餐饮', material: '菜名与价格已提供', feedback: '', length: 'std' };
  const media = compileContentEmployeeSoloPrompt(5, task);
  assert.ok(media.systemPrompt.includes(POSTER_TEXT_CAPABILITY.name));
  assert.ok(media.systemPrompt.includes('textOverlay'));
  const writer = compileContentEmployeeSoloPrompt(3, task);
  assert.equal(writer.systemPrompt.includes(POSTER_TEXT_CAPABILITY.name), false);

  const { ensureBaselineCatalogs } = await import('../src/baseline.js');
  await ensureBaselineCatalogs();
  const { buildEmployeeExecutionProfile } = await import('../src/employee-workbench.js');
  for (const idx of [140, 141]) {
    const contract = buildEmployeeExecutionProfile(idx, { tenantId: 1, user: boss });
    assert.ok(contract.systemContext.includes(POSTER_TEXT_CAPABILITY.name), `餐饮${idx} 契约模式未注入`);
    const paihuo = buildEmployeeExecutionProfile(idx, { tenantId: 1, user: boss, outputMode: 'paihuo_markdown' });
    assert.ok(paihuo.systemContext.includes(POSTER_TEXT_CAPABILITY.name), `餐饮${idx} 派活模式未注入`);
  }
  const other = buildEmployeeExecutionProfile(101, { tenantId: 1, user: boss });
  assert.equal(other.systemContext.includes(POSTER_TEXT_CAPABILITY.name), false);
});
