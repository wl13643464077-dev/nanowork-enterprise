#!/usr/bin/env node
/**
 * Builds the declarative content-employee profile catalog from the legacy
 * registry source without importing or executing the legacy application.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const registryPath = args.get('--registry');
const outputPath = args.get('--out');
if (!registryPath || !path.isAbsolute(registryPath) || !outputPath) {
  throw new Error('必须提供 --registry 绝对只读源码路径与 --out 输出路径');
}

const root = path.resolve(import.meta.dirname, '..');
const currentCatalog = JSON.parse(fs.readFileSync(path.join(root, 'server/catalog/content-crew.json'), 'utf8'));
const skillsCatalog = JSON.parse(fs.readFileSync(path.join(root, 'server/catalog/employee-skills.json'), 'utf8'));
const registrySource = fs.readFileSync(registryPath, 'utf8');
const registrySha256 = crypto.createHash('sha256').update(registrySource).digest('hex');
if (registrySha256 !== 'fb5e5d463e02be9b5ebdd24d3fe8533f4f33498a719a9913b32a9c24e75e80ce') {
  throw new Error('registry.py与已审核权威快照不一致');
}

const astReader = String.raw`
import ast, json, sys
tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
wanted = {
  "JSON_RULE", "CHANNEL_CATALOG", "DEFAULT_CHANNELS", "CAPABILITIES",
  "DEFAULT_DIMENSIONS", "PLATFORM_SPECS", "DEFAULT_PROMPTS", "PLACEHOLDERS"
}
env = {}
def value(node):
  if isinstance(node, ast.Constant):
    return node.value
  if isinstance(node, ast.List):
    return [value(item) for item in node.elts]
  if isinstance(node, ast.Tuple):
    return [value(item) for item in node.elts]
  if isinstance(node, ast.Dict):
    return {value(k): value(v) for k, v in zip(node.keys, node.values)}
  if isinstance(node, ast.Name) and node.id in env:
    return env[node.id]
  if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
    return value(node.left) + value(node.right)
  raise ValueError("unsupported safe AST node: " + ast.dump(node)[:160])
for statement in tree.body:
  if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
    name = statement.targets[0].id
    if name in wanted:
      env[name] = value(statement.value)
print(json.dumps({name: env[name] for name in wanted}, ensure_ascii=False))
`;
const sourceData = JSON.parse(execFileSync(
  'python3',
  ['-c', astReader, registryPath],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
));

const skillProfiles = new Map(
  skillsCatalog.profiles.filter(profile => profile.idx >= 0 && profile.idx <= 9)
    .map(profile => [profile.idx, profile]),
);
const approvals = {
  pick: '产出多个候选，由老板挑选后放行',
  review: '产出后由老板审批再放行',
  auto: '质量自查后自动放行',
  force: '强制终审，任何模式都必须等待老板确认',
};
const handlers = [
  'run_trend', 'run_research', 'run_benchmark', 'run_draft', 'run_style',
  'run_media', 'run_cover', 'run_deck', 'run_publish', 'run_retro',
];
const primaryArtifacts = ['json', 'json', 'json', 'markdown', 'markdown', 'images', 'covers', 'html', 'publish_packages', 'markdown'];
const connectorMap = {
  0: [{ kind: 'trend_research', primary: true, addon: false, legacyHandler: 'run_trend', newProjectStatus: 'catalog_only' }],
  1: [{ kind: 'evidence_research', primary: true, addon: false, legacyHandler: 'run_research', newProjectStatus: 'catalog_only' }],
  2: [{ kind: 'benchmark_analysis', primary: true, addon: false, legacyHandler: 'run_benchmark', newProjectStatus: 'catalog_only' }],
  3: [
    { kind: 'copy', primary: true, addon: false, legacyHandler: 'run_draft', newProjectStatus: 'single_station' },
    { kind: 'dailyPack', primary: false, addon: true, legacyHandler: 'run_draft', newProjectStatus: 'single_station' },
  ],
  4: [{ kind: 'style_rewrite', primary: true, addon: false, legacyHandler: 'run_style', newProjectStatus: 'catalog_only' }],
  5: [
    { kind: 'image', primary: true, addon: false, legacyHandler: 'run_media', newProjectStatus: 'single_station' },
    { kind: 'video', primary: false, addon: true, legacyHandler: null, newProjectStatus: 'single_station' },
  ],
  6: [{ kind: 'cover', primary: true, addon: false, legacyHandler: 'run_cover', newProjectStatus: 'catalog_only' }],
  7: [
    { kind: 'html', primary: true, addon: false, legacyHandler: 'run_deck', newProjectStatus: 'catalog_only' },
    { kind: 'ppt', primary: false, addon: true, legacyHandler: null, newProjectStatus: 'single_station' },
  ],
  8: [{ kind: 'publish_package', primary: true, addon: false, legacyHandler: 'run_publish', newProjectStatus: 'catalog_only' }],
  9: [{ kind: 'performance_retro', primary: true, addon: false, legacyHandler: 'run_retro', newProjectStatus: 'catalog_only' }],
};

const uploadAccept = ['.txt', '.md', '.csv', '.json', '.pdf', '.jpg', '.jpeg', '.png', '.webp'];
const soloTemplate = employee => `你是「老板的AI集团 · 内容生产部」的数字员工「${employee.name}」(部门:${employee.group})。
岗位职责:${employee.duty}。这次不是流水线作业,是老板单独派给你个人的活。

【你的多项能力(逐项运用)】
{required_capabilities}
{enabled_skills}
{tenant_company_profile_and_knowledge}
【老板的任务书】
- 任务:{direction}
- 行业/赛道:{industry}
- 老板给的材料:
{material}
- 老板对上一版的意见(必须落实):{feedback}

要求:按你的岗位专业标准独立完成,产出一份可直接使用的 Markdown 交付物(开头一行「# 标题」,结构清晰);材料不足就合理假设并标注「假设」;只输出 Markdown,不要客套。
{length_hint}`;

function roleSpecificConfig(employee, legacyProfile) {
  if (employee.key === 'trend' || employee.key === 'research') {
    return {
      kind: 'channel_matrix',
      catalog: sourceData.CHANNEL_CATALOG[employee.key],
      defaults: sourceData.DEFAULT_CHANNELS[employee.key],
      legacyOverride: legacyProfile.safeLegacyConfig.settings.channels || null,
    };
  }
  if (employee.key === 'benchmark') {
    return {
      kind: 'benchmark_matrix',
      defaults: { targets: [], dimensions: sourceData.DEFAULT_DIMENSIONS },
      legacyOverride: legacyProfile.safeLegacyConfig.settings,
    };
  }
  if (['media', 'cover', 'publish'].includes(employee.key)) {
    return { kind: 'platform_specs', defaults: sourceData.PLATFORM_SPECS };
  }
  return { kind: 'standard', defaults: { useRequiredCapabilities: true, useEnabledSkills: true } };
}

const employees = currentCatalog.employees.map((employee, order, allEmployees) => {
  const legacyProfile = skillProfiles.get(employee.idx);
  if (!legacyProfile) throw new Error(`内容员工${employee.idx}缺少安全技能档案`);
  const template = sourceData.DEFAULT_PROMPTS[employee.key];
  const outputContract = template.split(sourceData.JSON_RULE)[1];
  if (!outputContract) throw new Error(`内容员工${employee.idx}缺少输出契约`);
  const previous = allEmployees[order - 1] || null;
  const next = allEmployees[order + 1] || null;
  return {
    ...employee,
    capabilities: sourceData.CAPABILITIES[employee.key].map(capability => ({
      ...capability, required: true, enabled: true, locked: true,
    })),
    skillProfile: {
      catalog: 'employee-skills.json',
      employeeIdx: employee.idx,
      expectedSkillCount: legacyProfile.expectedSkillCount,
      verificationStatus: 'legacy_unverified',
    },
    systemPrompt: {
      messageMode: 'none',
      template: null,
      reason: '旧版供应商调用把完整拼装提示词作为单个role=user消息发送，没有独立system消息。',
    },
    pipelinePrompt: {
      messageMode: 'single_user',
      legacyBuilder: 'build_prompt',
      assemblyOrder: [
        'boss_brief_and_persona',
        'required_capabilities',
        'tenant_company_profile',
        'tenant_knowledge',
        'enabled_skill_cards',
        'role_template',
      ],
      template,
    },
    soloPrompt: {
      messageMode: 'single_user',
      legacyBuilder: 'solo_prompt',
      template: soloTemplate(employee),
      placeholders: {
        required_capabilities: '全部必备硬能力',
        enabled_skills: '启用中的历史或后续学习技能',
        tenant_company_profile_and_knowledge: '当前租户企业档案与知识沉淀',
        direction: '任务内容',
        industry: '行业/赛道',
        material: '补充材料',
        feedback: '上一版反馈',
        length_hint: '篇幅约束',
      },
    },
    placeholders: sourceData.PLACEHOLDERS[employee.key],
    workMethod: {
      input: {
        upstream: previous ? `工位${previous.idx + 1}·${previous.name}产出` : '老板Brief',
        context: ['老板Brief', '账号人设档案', '企业档案', '公司知识沉淀', '返工意见'],
      },
      execution: {
        handler: handlers[employee.idx],
        capabilities: '逐项运用全部必备硬能力，缺一不可',
        skills: '启用技能自动注入工作提示词',
        webRequired: ['trend', 'research', 'benchmark'].includes(employee.key),
        realtimeSteps: true,
      },
      output: {
        duty: employee.duty,
        keys: employee.outputKeys,
        primaryArtifact: primaryArtifacts[employee.idx],
      },
      approval: { code: employee.approval, description: approvals[employee.approval] },
      handoff: {
        target: next ? `工位${next.idx + 1}·${next.name}` : '交付包与知识沉淀',
        optional: employee.optional,
        qualityGateBefore: employee.idx === 8,
      },
    },
    defaultWorkConfig: {
      common: {
        capabilitiesRequired: true,
        capabilitiesEnabled: true,
        capabilitiesLocked: true,
        skillVerificationStatus: 'legacy_unverified',
        textModel: legacyProfile.safeLegacyConfig.modelText || 'inherit',
        imageModel: legacyProfile.safeLegacyConfig.modelImage || 'inherit',
        approval: employee.approval,
        optional: employee.optional,
        messageMode: 'single_user',
      },
      roleSpecific: roleSpecificConfig(employee, legacyProfile),
    },
    dispatchForm: {
      mode: 'single_station',
      fields: [
        { key: 'direction', label: '任务内容', type: 'textarea', required: true },
        { key: 'industry', label: '行业', type: 'text', required: false },
        { key: 'material', label: '材料', type: 'textarea_upload', required: false, accept: uploadAccept },
        {
          key: 'length', label: '篇幅', type: 'select', required: true, default: 'std',
          options: [
            { value: 'lite', label: '精简' },
            { value: 'std', label: '标准' },
            { value: 'full', label: '详尽' },
          ],
        },
      ],
      result: { format: 'markdown', persistedAsAsset: true, supportsRedoFeedback: true },
    },
    outputSchema: {
      format: 'json_object',
      keys: employee.outputKeys,
      contract: outputContract,
      primaryArtifact: primaryArtifacts[employee.idx],
    },
    connectorPolicy: {
      executionBoundary: '静态完整岗位能力不等于新项目已接通十工位自动流水线',
      connectors: connectorMap[employee.idx],
    },
    sourceProvenance: {
      project: '派活AI',
      referencePath: 'app/skills/registry.py',
      referenceSha256: registrySha256,
      legacyIdx: employee.idx,
      snapshotDate: '2026-07-23',
    },
  };
});

const result = {
  ...currentCatalog,
  schemaVersion: 'paihuo-content-crew.v2',
  source: {
    ...currentCatalog.source,
    referenceSha256: registrySha256,
    profilePolicy: 'Full declarative profiles; no legacy runtime import or database dependency.',
  },
  employees,
};
fs.writeFileSync(path.resolve(root, outputPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
