#!/usr/bin/env node
/**
 * Builds the declarative content-employee profile catalog from the legacy
 * registry source without importing or executing the legacy application.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { currentPaihuoSourceTemplate } from "./lib/paihuo-content-prompt-migration.mjs";

const EXPECTED_REGISTRY_SHA256 =
  "9663481bfb2a709209281c1eb356783f9d5b4047dc54124cfa27f3e4986237dc";
const SOURCE_FINGERPRINT_ALGORITHM = "sha256-json-utf8";

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonFingerprint(value) {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function textFingerprint(value) {
  return `sha256:${sha256(value)}`;
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const registryPath = args.get("--registry");
const outputPath = args.get("--out");
if (!registryPath || !path.isAbsolute(registryPath) || !outputPath) {
  throw new Error("必须提供 --registry 绝对只读源码路径与 --out 输出路径");
}

const root = path.resolve(import.meta.dirname, "..");
const currentCatalog = JSON.parse(
  fs.readFileSync(path.join(root, "server/catalog/content-crew.json"), "utf8"),
);
const skillsCatalog = JSON.parse(
  fs.readFileSync(
    path.join(root, "server/catalog/employee-skills.json"),
    "utf8",
  ),
);
const registrySource = fs.readFileSync(registryPath, "utf8");
const registrySha256 = sha256(registrySource);
if (registrySha256 !== EXPECTED_REGISTRY_SHA256) {
  throw new Error("registry.py与已审核权威快照不一致");
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
const sourceData = JSON.parse(
  execFileSync("python3", ["-c", astReader, registryPath], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }),
);
const sourceCapabilityCount = Object.values(sourceData.CAPABILITIES).reduce(
  (total, capabilities) => total + capabilities.length,
  0,
);
const sourcePromptCount = Object.keys(sourceData.DEFAULT_PROMPTS).length;
if (sourceCapabilityCount !== 45 || sourcePromptCount !== 10) {
  throw new Error(
    `registry.py权威字段数量不正确：能力${sourceCapabilityCount}/45，提示词${sourcePromptCount}/10`,
  );
}
const currentSourcePrompts = Object.fromEntries(
  Object.entries(sourceData.DEFAULT_PROMPTS)
    .map(([key, value]) => [key, currentPaihuoSourceTemplate(value)]),
);

const skillProfiles = new Map(
  skillsCatalog.profiles
    .filter((profile) => profile.idx >= 0 && profile.idx <= 9)
    .map((profile) => [profile.idx, profile]),
);
const approvals = {
  pick: "产出多个候选，由老板挑选后放行",
  review: "产出后由老板审批再放行",
  auto: "质量自查后自动放行",
  force: "强制终审，任何模式都必须等待老板确认",
};
const handlers = [
  "run_trend",
  "run_research",
  "run_benchmark",
  "run_draft",
  "run_style",
  "run_media",
  "run_cover",
  "run_deck",
  "run_publish",
  "run_retro",
];
const primaryArtifacts = [
  "json",
  "json",
  "json",
  "markdown",
  "markdown",
  "images",
  "covers",
  "html",
  "publish_packages",
  "markdown",
];
const connectorMap = {
  0: [
    {
      kind: "trend_research",
      primary: true,
      addon: false,
      legacyHandler: "run_trend",
      newProjectStatus: "catalog_only",
    },
  ],
  1: [
    {
      kind: "evidence_research",
      primary: true,
      addon: false,
      legacyHandler: "run_research",
      newProjectStatus: "catalog_only",
    },
  ],
  2: [
    {
      kind: "benchmark_analysis",
      primary: true,
      addon: false,
      legacyHandler: "run_benchmark",
      newProjectStatus: "catalog_only",
    },
  ],
  3: [
    {
      kind: "copy",
      primary: true,
      addon: false,
      legacyHandler: "run_draft",
      newProjectStatus: "single_station",
    },
    {
      kind: "dailyPack",
      primary: false,
      addon: true,
      legacyHandler: "run_draft",
      newProjectStatus: "single_station",
    },
  ],
  4: [
    {
      kind: "style_rewrite",
      primary: true,
      addon: false,
      legacyHandler: "run_style",
      newProjectStatus: "catalog_only",
    },
  ],
  5: [
    {
      kind: "image",
      primary: true,
      addon: false,
      legacyHandler: "run_media",
      newProjectStatus: "single_station",
    },
    {
      kind: "video",
      primary: false,
      addon: true,
      legacyHandler: null,
      newProjectStatus: "single_station",
    },
  ],
  6: [
    {
      kind: "cover",
      primary: true,
      addon: false,
      legacyHandler: "run_cover",
      newProjectStatus: "catalog_only",
    },
  ],
  7: [
    {
      kind: "html",
      primary: true,
      addon: false,
      legacyHandler: "run_deck",
      newProjectStatus: "catalog_only",
    },
    {
      kind: "ppt",
      primary: false,
      addon: true,
      legacyHandler: null,
      newProjectStatus: "single_station",
    },
  ],
  8: [
    {
      kind: "publish_package",
      primary: true,
      addon: false,
      legacyHandler: "run_publish",
      newProjectStatus: "catalog_only",
    },
  ],
  9: [
    {
      kind: "performance_retro",
      primary: true,
      addon: false,
      legacyHandler: "run_retro",
      newProjectStatus: "catalog_only",
    },
  ],
};

const uploadAccept = [
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
];
const soloTemplate = (
  employee,
) => `你是「老板的AI集团 · 内容生产部」的数字员工「${employee.name}」(部门:${employee.group})。
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
  if (employee.key === "trend" || employee.key === "research") {
    return {
      kind: "channel_matrix",
      catalog: sourceData.CHANNEL_CATALOG[employee.key],
      defaults: sourceData.DEFAULT_CHANNELS[employee.key],
      legacyOverride: legacyProfile.safeLegacyConfig.settings.channels || null,
    };
  }
  if (employee.key === "benchmark") {
    return {
      kind: "benchmark_matrix",
      defaults: { targets: [], dimensions: sourceData.DEFAULT_DIMENSIONS },
      legacyOverride: legacyProfile.safeLegacyConfig.settings,
    };
  }
  if (["media", "cover", "publish"].includes(employee.key)) {
    return { kind: "platform_specs", defaults: sourceData.PLATFORM_SPECS };
  }
  return {
    kind: "standard",
    defaults: { useRequiredCapabilities: true, useEnabledSkills: true },
  };
}

function sourceConnectorTopology(employee) {
  const sourceConnectors = connectorMap[employee.idx] || [];
  const currentConnectors = employee.connectorPolicy?.connectors || [];
  if (sourceConnectors.length !== currentConnectors.length) {
    throw new Error(`内容员工${employee.idx}连接器拓扑数量与旧源不一致`);
  }
  for (const sourceConnector of sourceConnectors) {
    const current = currentConnectors.find(
      (candidate) => candidate.kind === sourceConnector.kind,
    );
    if (
      !current ||
      current.primary !== sourceConnector.primary ||
      current.addon !== sourceConnector.addon ||
      current.legacyHandler !== sourceConnector.legacyHandler
    ) {
      throw new Error(
        `内容员工${employee.idx}连接器${sourceConnector.kind}与旧源拓扑不一致`,
      );
    }
    if (
      current.newProjectStatus === "catalog_only" ||
      current.status === "catalog_only"
    ) {
      throw new Error(
        `内容员工${employee.idx}连接器${sourceConnector.kind}不得退回catalog_only`,
      );
    }
  }
}

const employees = currentCatalog.employees.map((employee) => {
    const legacyProfile = skillProfiles.get(employee.idx);
    if (!legacyProfile)
      throw new Error(`内容员工${employee.idx}缺少安全技能档案`);
    const sourceTemplate = sourceData.DEFAULT_PROMPTS[employee.key];
    const sourceCapabilities = sourceData.CAPABILITIES[employee.key];
    if (typeof sourceTemplate !== "string" || !sourceTemplate.trim()) {
      throw new Error(`内容员工${employee.idx}缺少旧源提示词`);
    }
    if (
      !Array.isArray(sourceCapabilities) ||
      sourceCapabilities.length !== employee.capabilities.length
    ) {
      throw new Error(`内容员工${employee.idx}能力数量与旧源不一致`);
    }
    sourceConnectorTopology(employee);
    const capabilities = employee.capabilities.map((capability, index) => {
      const sourceDefinition = sourceCapabilities[index];
      if (
        capability.name !== sourceDefinition.name ||
        capability.emoji !== sourceDefinition.emoji
      ) {
        throw new Error(
          `内容员工${employee.idx}能力${index + 1}与旧源错位`,
        );
      }
      return {
        ...capability,
        sourceDefinition,
        sourceFingerprint: jsonFingerprint(sourceDefinition),
      };
    });
    const sourceCapabilitySetFingerprint = jsonFingerprint(sourceCapabilities);
    const currentTemplate = currentPaihuoSourceTemplate(sourceTemplate);
    const sourcePromptFingerprint = textFingerprint(currentTemplate);
    return {
      ...employee,
      capabilities,
      pipelinePrompt: {
        ...employee.pipelinePrompt,
        sourceTemplate: currentTemplate,
        sourceFingerprint: sourcePromptFingerprint,
      },
      placeholders: sourceData.PLACEHOLDERS[employee.key],
      sourceProvenance: {
        ...employee.sourceProvenance,
        referenceSha256: registrySha256,
        snapshotDate: "2026-08-01",
        sourceCapabilitySetFingerprint,
        sourcePromptFingerprint,
      },
    };
  });

const result = {
  ...currentCatalog,
  schemaVersion: "paihuo-content-crew.v2",
  source: {
    ...currentCatalog.source,
    referenceSha256: registrySha256,
    snapshotDate: "2026-08-01",
    sourceFingerprintAlgorithm: SOURCE_FINGERPRINT_ALGORITHM,
    capabilityCount: sourceCapabilityCount,
    promptCount: sourcePromptCount,
    capabilitySetFingerprint: jsonFingerprint(sourceData.CAPABILITIES),
    promptSetFingerprint: jsonFingerprint(currentSourcePrompts),
    profilePolicy:
      "Full declarative profiles; no legacy runtime import or database dependency.",
  },
  employees,
};
fs.writeFileSync(
  path.resolve(root, outputPath),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
