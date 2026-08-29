import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_CREW,
  CONTENT_EMPLOYEES,
  EMPLOYEE_SKILL_PROFILES,
} from '../src/catalog/content-crew.js';
import { compileContentEmployeeSoloPrompt } from '../src/engines/content-employee-workbench.js';
import { currentPaihuoSourceTemplate } from '../../scripts/lib/paihuo-content-prompt-migration.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..', '..');
const exporterPath = path.join(projectRoot, 'scripts', 'export-paihuo-content-profiles.mjs');
const defaultRegistryPath = path.resolve(
  projectRoot,
  '..',
  '派活AI',
  'app',
  'skills',
  'registry.py',
);
const registryPath = process.env.PAIHUO_CONTENT_REGISTRY_PATH || defaultRegistryPath;
const registryAstReader = String.raw`
import ast, json, sys
tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
wanted = {"JSON_RULE", "CAPABILITIES", "DEFAULT_PROMPTS"}
env = {}
def value(node):
  if isinstance(node, ast.Constant): return node.value
  if isinstance(node, ast.List): return [value(item) for item in node.elts]
  if isinstance(node, ast.Tuple): return [value(item) for item in node.elts]
  if isinstance(node, ast.Dict): return {value(k): value(v) for k, v in zip(node.keys, node.values)}
  if isinstance(node, ast.Name) and node.id in env: return env[node.id]
  if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add): return value(node.left) + value(node.right)
  raise ValueError("unsupported source node")
for statement in tree.body:
  if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
    name = statement.targets[0].id
    if name in wanted: env[name] = value(statement.value)
print(json.dumps({name: env[name] for name in ("CAPABILITIES", "DEFAULT_PROMPTS")}, ensure_ascii=False))
`;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function jsonFingerprint(value) {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function textFingerprint(value) {
  return `sha256:${sha256(value)}`;
}

function taskFor(employee) {
  return {
    direction: `验收${employee.name}完整源结构注入`,
    industry: '餐饮',
    material: '本次只验收源字段、当前安全覆盖层和快照一致性。',
    feedback: '不得把未核验的历史说法当作当前事实。',
    length: 'lite',
  };
}

function sourceLayer(catalog) {
  return {
    source: catalog.source,
    employees: catalog.employees.map(employee => ({
      idx: employee.idx,
      key: employee.key,
      capabilities: employee.capabilities.map(capability => ({
        sourceDefinition: capability.sourceDefinition,
        sourceFingerprint: capability.sourceFingerprint,
      })),
      pipelinePrompt: {
        sourceTemplate: employee.pipelinePrompt.sourceTemplate,
        sourceFingerprint: employee.pipelinePrompt.sourceFingerprint,
      },
      sourceProvenance: employee.sourceProvenance,
      connectorPolicy: employee.connectorPolicy,
    })),
  };
}

test('源目录固定45项能力、10份提示词与65张内容岗历史技能指纹', () => {
  const capabilities = CONTENT_EMPLOYEES.flatMap(employee => employee.capabilities);
  const contentProfiles = EMPLOYEE_SKILL_PROFILES.filter(profile => profile.idx < 10);
  const skills = contentProfiles.flatMap(profile => profile.skills);

  assert.equal(capabilities.length, 45);
  assert.equal(CONTENT_EMPLOYEES.length, 10);
  assert.equal(skills.length, 65);
  assert.equal(CONTENT_CREW.source.capabilityCount, 45);
  assert.equal(CONTENT_CREW.source.promptCount, 10);

  const capabilitySets = {};
  const promptSet = {};
  for (const employee of CONTENT_EMPLOYEES) {
    capabilitySets[employee.key] = employee.capabilities.map(capability => {
      assert.equal(
        capability.sourceFingerprint,
        jsonFingerprint(capability.sourceDefinition),
      );
      return capability.sourceDefinition;
    });
    assert.equal(
      employee.pipelinePrompt.sourceFingerprint,
      textFingerprint(employee.pipelinePrompt.sourceTemplate),
    );
    promptSet[employee.key] = employee.pipelinePrompt.sourceTemplate;
  }
  assert.equal(
    CONTENT_CREW.source.capabilitySetFingerprint,
    jsonFingerprint(capabilitySets),
  );
  assert.equal(CONTENT_CREW.source.promptSetFingerprint, jsonFingerprint(promptSet));
});

test('模型system按派活分层装入能力与执行模板，快照完整保留45能力、10提示词和65技能', () => {
  let capabilityCount = 0;
  let promptCount = 0;
  let skillCount = 0;

  for (const employee of CONTENT_EMPLOYEES) {
    const compiled = compileContentEmployeeSoloPrompt(employee.idx, taskFor(employee), {
      executionMode: 'pipeline',
    });
    const rewrittenPipeline = String(employee.pipelinePrompt.template || '').replace(
      /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/gu,
      (_match, name) => `（读取用户消息中的运行参数.${name}）`,
    );
    const overlayOffset = compiled.systemPrompt.indexOf(
      '派活源定义与历史技能的当前事实核验安全覆盖层',
    );

    assert.ok(compiled.systemPrompt.includes('【内部岗位执行模板】'), `${employee.name}未注入执行模板`);
    assert.ok(
      compiled.systemPrompt.includes(rewrittenPipeline),
      `${employee.name}源岗位提示词未按派活方式注入system`,
    );
    assert.ok(
      overlayOffset > compiled.systemPrompt.indexOf('【内部岗位执行模板】'),
      `${employee.name}安全覆盖层必须位于执行模板之后`,
    );
    assert.equal(
      compiled.snapshot.prompts.pipelinePrompt.sourceTemplate,
      employee.pipelinePrompt.sourceTemplate,
    );
    assert.equal(
      compiled.snapshot.prompts.pipelinePrompt.sourceFingerprint,
      employee.pipelinePrompt.sourceFingerprint,
    );
    promptCount += 1;

    for (const capability of employee.capabilities) {
      assert.ok(compiled.systemPrompt.includes(`- ${capability.name}:${capability.desc}`));
      assert.equal(compiled.systemPrompt.includes(JSON.stringify(capability.sourceDefinition)), false);
      assert.equal(compiled.systemPrompt.includes(capability.sourceFingerprint), false);
      const snapshotCapability = compiled.snapshot.capabilities.find(
        candidate => candidate.sourceFingerprint === capability.sourceFingerprint,
      );
      assert.deepEqual(snapshotCapability.sourceDefinition, capability.sourceDefinition);
      capabilityCount += 1;
    }

    const profile = EMPLOYEE_SKILL_PROFILES.find(candidate => candidate.idx === employee.idx);
    const injected = profile.skills.filter(skill => compiled.systemPrompt.includes(`【${skill.title}】`));
    assert.ok(injected.length >= 1, `${employee.name}未主动运用历史技能`);
    for (const skill of profile.skills) {
      const snapshotSkill = compiled.snapshot.skillLibrary.historical.find(
        candidate => candidate.contentFingerprint === skill.contentFingerprint,
      );
      assert.equal(snapshotSkill.detail, skill.detail);
      assert.equal(compiled.systemPrompt.includes(skill.contentFingerprint), false);
      skillCount += 1;
    }
    for (const skill of injected) {
      assert.ok(compiled.systemPrompt.includes(skill.detail));
      assert.ok(overlayOffset > compiled.systemPrompt.indexOf(`【${skill.title}】`));
    }
  }

  assert.deepEqual(
    { capabilityCount, promptCount, skillCount },
    { capabilityCount: 45, promptCount: 10, skillCount: 65 },
  );
});

test('导出器与目录共用同一个旧源SHA锁，防止目录单边漂移', () => {
  const exporter = fs.readFileSync(exporterPath, 'utf8');
  const match = exporter.match(
    /const EXPECTED_REGISTRY_SHA256\s*=\s*\n?\s*"([a-f0-9]{64})"/u,
  );
  assert.ok(match, '导出器必须显式锁定旧源SHA');
  assert.equal(match[1], CONTENT_CREW.source.referenceSha256);
  assert.equal(
    CONTENT_EMPLOYEES.every(employee => (
      employee.sourceProvenance.referenceSha256 === match[1]
    )),
    true,
  );
});

test('当旧派活源可用时，重生成必须确定性等于当前源层并保留诚实连接器状态', {
  skip: fs.existsSync(registryPath) ? false : `未提供旧源：${registryPath}`,
}, () => {
  const registrySource = fs.readFileSync(registryPath, 'utf8');
  assert.equal(sha256(registrySource), CONTENT_CREW.source.referenceSha256);
  const oldSourceFields = JSON.parse(execFileSync('python3', [
    '-c',
    registryAstReader,
    registryPath,
  ], { encoding: 'utf8' }));
  for (const employee of CONTENT_EMPLOYEES) {
    assert.deepEqual(
      employee.capabilities.map(capability => capability.sourceDefinition),
      oldSourceFields.CAPABILITIES[employee.key],
    );
    assert.equal(
      employee.pipelinePrompt.sourceTemplate,
      currentPaihuoSourceTemplate(oldSourceFields.DEFAULT_PROMPTS[employee.key]),
    );
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'paihuo-content-source-'));
  try {
    const firstOutput = path.join(temporaryDirectory, 'first.json');
    const secondOutput = path.join(temporaryDirectory, 'second.json');
    for (const output of [firstOutput, secondOutput]) {
      execFileSync(process.execPath, [
        exporterPath,
        '--registry',
        registryPath,
        '--out',
        output,
      ], { cwd: projectRoot, stdio: 'pipe' });
    }
    const first = JSON.parse(fs.readFileSync(firstOutput, 'utf8'));
    const second = JSON.parse(fs.readFileSync(secondOutput, 'utf8'));
    assert.deepEqual(sourceLayer(first), sourceLayer(CONTENT_CREW));
    assert.deepEqual(sourceLayer(second), sourceLayer(CONTENT_CREW));
    assert.equal(
      first.employees.flatMap(employee => employee.connectorPolicy.connectors)
        .some(connector => connector.status === 'catalog_only'),
      false,
    );

    const driftedRegistry = path.join(temporaryDirectory, 'registry-drift.py');
    fs.writeFileSync(driftedRegistry, `${registrySource}\n`, 'utf8');
    const drift = spawnSync(process.execPath, [
      exporterPath,
      '--registry',
      driftedRegistry,
      '--out',
      path.join(temporaryDirectory, 'drift.json'),
    ], { cwd: projectRoot, encoding: 'utf8' });
    assert.notEqual(drift.status, 0);
    assert.match(`${drift.stdout}\n${drift.stderr}`, /与已审核权威快照不一致/u);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
