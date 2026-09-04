#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { writePrivateArtifact } from "../server/src/engines/private-artifact.js";

import {
  buildFullFeatureReport,
  renderFullFeatureMarkdown,
} from "./lib/full-feature-report.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_ARTIFACTS_ROOT = path.join(REPOSITORY_ROOT, "artifacts");

function usage() {
  return `NanoWork 用户版全功能报告导出器

用法：
  node scripts/export-full-feature-report.mjs \\
    --inventory artifacts/full-feature-inventory.json \\
    --get artifacts/http-get-probe.json \\
    --write artifacts/http-write-probe.json \\
    --web artifacts/web-route-report.json \\
    --employee artifacts/real-employee-matrix.json \\
    --content artifacts/real-content-automation-matrix.json \\
    --json-out artifacts/nanowork-full-feature-report.json \\
    --feature artifacts/real-feature-matrix-2026-08-20.json \\
    --output-quality artifacts/real-employee-output-quality-audit-v5-restaurant-2026-07-31.json \\
    --output-quality artifacts/real-employee-output-quality-audit-preupgrade-invalidated.json \\
    --md-out artifacts/nanowork-full-feature-report.md

参数：
  --inventory FILE      修正后功能清单 JSON（必填）
  --get FILE            GET 语义探针 v2 JSON（必填）
  --write FILE          隔离库写接口语义探针 v2 JSON（必填）
  --web FILE            页面语义验收 v2 JSON（必填）
  --employee FILE       数字员工真实矩阵 v2 JSON（必填）
  --content FILE        内容自动化真实矩阵 v2 JSON（必填）
  --feature FILE        业务功能真实矩阵 v8 JSON（必填，按历史快照展示）
  --business-feature FILE
                        --feature 的兼容别名
  --output-quality FILE 员工输出质量审计 JSON（必填，可重复）
                        最新有效 v3 用于首页；旧 v1/无效源仍纳入作废诊断
  --quality FILE        --output-quality 的兼容别名（可重复）
  --json-out FILE       完整语义 JSON 输出（必填）
  --md-out FILE         用户版 Markdown 输出（必填）
  --superseded FILE     需在首页标记 INVALID/SUPERSEDED 的旧报告（可重复）
  --project-url URL     项目地址
  --title TEXT          报告标题
  --generated-at ISO    固定生成时间（CI/复现用）
  --help                显示帮助
`;
}

function parseArgs(argv) {
  const values = {};
  const superseded = [];
  const outputQuality = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help") return { help: true };
    if (!item.startsWith("--")) throw new Error(`未知参数：${item}`);
    const separator = item.indexOf("=");
    const key = separator >= 0 ? item.slice(0, separator) : item;
    const inline = separator >= 0 ? item.slice(separator + 1) : null;
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key}缺少参数值`);
    if (key === "--superseded") superseded.push(value);
    else if (["--quality", "--output-quality"].includes(key))
      outputQuality.push(value);
    else if (key === "--feature") values["--business-feature"] = value;
    else values[key] = value;
  }
  const allowed = new Set([
    "--inventory",
    "--get",
    "--write",
    "--web",
    "--employee",
    "--content",
    "--business-feature",
    "--json-out",
    "--md-out",
    "--project-url",
    "--title",
    "--generated-at",
  ]);
  for (const key of Object.keys(values))
    if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
  const required = [
    "--inventory",
    "--get",
    "--write",
    "--web",
    "--employee",
    "--content",
    "--json-out",
    "--md-out",
  ];
  for (const key of required)
    if (!values[key]) throw new Error(`${key}为必填参数`);
  if (!values["--business-feature"])
    throw new Error("必须提供 --feature（或 --business-feature）");
  if (!outputQuality.length)
    throw new Error("至少需要一个 --output-quality 输出质量证据");
  return {
    help: false,
    files: {
      inventory: path.resolve(values["--inventory"]),
      get: path.resolve(values["--get"]),
      write: path.resolve(values["--write"]),
      web: path.resolve(values["--web"]),
      employee: path.resolve(values["--employee"]),
      content: path.resolve(values["--content"]),
      businessFeature: path.resolve(values["--business-feature"]),
    },
    outputQualityFiles: outputQuality.map((file) => path.resolve(file)),
    jsonOut: path.resolve(values["--json-out"]),
    mdOut: path.resolve(values["--md-out"]),
    superseded: superseded.map((file) => path.resolve(file)),
    projectUrl: values["--project-url"] || "http://127.0.0.1:3107/",
    title: values["--title"] || "NanoWork 用户版全功能验收报告",
    generatedAt: values["--generated-at"] || new Date().toISOString(),
  };
}

function readJsonWithMeta(file) {
  const raw = fs.readFileSync(file, "utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`JSON解析失败 ${file}：${error.message}`);
  }
  return {
    value,
    meta: {
      path: file,
      bytes: Buffer.byteLength(raw),
      sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    },
  };
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function unsafeRelativeReference(reference) {
  if (!reference || reference.includes("\0")) return true;
  if (
    path.isAbsolute(reference) ||
    /^[A-Za-z]:[\\/]/u.test(reference) ||
    /^(?:\\\\|\/\/)/u.test(reference)
  ) {
    return true;
  }
  return reference.split(/[\\/]+/u).includes("..");
}

function matrixReferenceBase({
  declaredFile = null,
  declaredSha256 = null,
  status,
  reasonCode,
}) {
  return {
    status,
    reasonCode,
    declaredFile,
    resolvedPath: null,
    exists: false,
    bytes: null,
    declaredSha256,
    actualSha256: null,
    hashMatches: false,
  };
}

export function inspectReferencedQualityMatrix(
  qualityFile,
  report,
  { artifactsRoot = DEFAULT_ARTIFACTS_ROOT } = {},
) {
  const declaredValue = report?.source?.matrixFile;
  const rawDeclaredFile =
    typeof declaredValue === "string" ? declaredValue.trim() : "";
  const declaredFile = rawDeclaredFile.slice(0, 500);
  const declaredHashValue = report?.source?.matrixSha256;
  const declaredSha256 =
    typeof declaredHashValue === "string"
      ? declaredHashValue.trim().toLowerCase()
      : null;
  const base = {
    declaredFile: declaredFile || null,
    declaredSha256,
  };
  if (!declaredFile) {
    return matrixReferenceBase({
      ...base,
      status: "invalid_reference",
      reasonCode: "MATRIX_FILE_MISSING",
    });
  }
  if (rawDeclaredFile.length > 500) {
    return matrixReferenceBase({
      ...base,
      status: "invalid_reference",
      reasonCode: "MATRIX_PATH_TOO_LONG",
    });
  }
  if (unsafeRelativeReference(rawDeclaredFile)) {
    return matrixReferenceBase({
      ...base,
      status: "unsafe_path",
      reasonCode: "MATRIX_PATH_UNSAFE",
    });
  }

  const normalizedReference = rawDeclaredFile.replaceAll("\\", "/");
  const qualityDirectory = path.resolve(path.dirname(qualityFile));
  const resolvedArtifactsRoot = path.resolve(artifactsRoot);
  const candidates = [];
  const addCandidate = (root, candidate) => {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    if (!pathIsWithin(resolvedRoot, resolvedCandidate)) return;
    if (candidates.some((entry) => entry.candidate === resolvedCandidate)) {
      return;
    }
    candidates.push({ root: resolvedRoot, candidate: resolvedCandidate });
  };
  addCandidate(
    qualityDirectory,
    path.resolve(qualityDirectory, normalizedReference),
  );
  if (normalizedReference.startsWith("artifacts/")) {
    addCandidate(
      resolvedArtifactsRoot,
      path.resolve(REPOSITORY_ROOT, normalizedReference),
    );
  }
  addCandidate(
    resolvedArtifactsRoot,
    path.resolve(resolvedArtifactsRoot, normalizedReference),
  );

  const existing = candidates.find(({ candidate }) => fs.existsSync(candidate));
  if (!existing) {
    return {
      ...matrixReferenceBase({
        ...base,
        status: "missing",
        reasonCode: "MATRIX_FILE_NOT_FOUND",
      }),
      resolvedPath: candidates[0]?.candidate || null,
    };
  }

  let realRoot;
  let realCandidate;
  try {
    realRoot = fs.realpathSync(existing.root);
    realCandidate = fs.realpathSync(existing.candidate);
  } catch (error) {
    return {
      ...matrixReferenceBase({
        ...base,
        status: "unreadable",
        reasonCode: "MATRIX_REALPATH_UNREADABLE",
      }),
      resolvedPath: existing.candidate,
      errorCode: String(error?.code || "UNKNOWN").slice(0, 40),
    };
  }
  if (!pathIsWithin(realRoot, realCandidate)) {
    return matrixReferenceBase({
      ...base,
      status: "unsafe_path",
      reasonCode: "MATRIX_SYMLINK_ESCAPES_ROOT",
    });
  }

  let stat;
  let raw;
  try {
    stat = fs.statSync(realCandidate);
    if (!stat.isFile()) {
      return {
        ...matrixReferenceBase({
          ...base,
          status: "unreadable",
          reasonCode: "MATRIX_REFERENCE_NOT_FILE",
        }),
        resolvedPath: realCandidate,
        exists: true,
      };
    }
    raw = fs.readFileSync(realCandidate);
  } catch (error) {
    return {
      ...matrixReferenceBase({
        ...base,
        status: "unreadable",
        reasonCode: "MATRIX_FILE_UNREADABLE",
      }),
      resolvedPath: realCandidate,
      exists: true,
      errorCode: String(error?.code || "UNKNOWN").slice(0, 40),
    };
  }
  const actualSha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const declaredHashValid = /^[a-f0-9]{64}$/u.test(declaredSha256 || "");
  const hashMatches = declaredHashValid && declaredSha256 === actualSha256;
  return {
    status: !declaredHashValid
      ? "declared_hash_invalid"
      : hashMatches
        ? "verified"
        : "hash_mismatch",
    reasonCode: !declaredHashValid
      ? "MATRIX_DECLARED_HASH_INVALID"
      : hashMatches
        ? "MATRIX_HASH_VERIFIED"
        : "MATRIX_HASH_MISMATCH",
    declaredFile,
    resolvedPath: realCandidate,
    exists: true,
    bytes: raw.byteLength,
    declaredSha256,
    actualSha256,
    hashMatches,
  };
}

function atomicWrite(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writePrivateArtifact(file, body, { overwrite: true });
}

export function exportFullFeatureReport(options) {
  if (!options?.files?.businessFeature)
    throw new Error("必须提供 --feature（或 --business-feature）");
  if (
    !Array.isArray(options.outputQualityFiles) ||
    options.outputQualityFiles.length === 0
  ) {
    throw new Error("至少需要一个 --output-quality 输出质量证据");
  }
  const inputs = {};
  const sourceFiles = {};
  for (const [name, file] of Object.entries(options.files)) {
    const loaded = readJsonWithMeta(file);
    inputs[name] = loaded.value;
    sourceFiles[name] = loaded.meta;
  }
  const outputQualityLoaded = options.outputQualityFiles.map((file) => {
    const loaded = readJsonWithMeta(file);
    loaded.meta.referencedMatrix = inspectReferencedQualityMatrix(
      file,
      loaded.value,
    );
    return loaded;
  });
  inputs.outputQuality = outputQualityLoaded.map((entry) => entry.value);
  sourceFiles.outputQuality = outputQualityLoaded.map((entry) => entry.meta);
  const supersededArtifacts = (options.superseded || []).map((file) => ({
    path: file,
    reason: "旧报告采用了已废弃的“只要有响应就算已真实执行”口径。",
    replacement: options.mdOut,
  }));
  const report = buildFullFeatureReport({
    inventory: inputs.inventory,
    getReport: inputs.get,
    writeReport: inputs.write,
    webReport: inputs.web,
    employeeReport: inputs.employee,
    contentReport: inputs.content,
    businessFeatureReport: inputs.businessFeature,
    outputQualityReports: inputs.outputQuality,
    sourceFiles,
    supersededArtifacts,
    generatedAt: options.generatedAt,
    projectUrl: options.projectUrl,
    title: options.title,
  });
  const markdown = renderFullFeatureMarkdown(report);
  atomicWrite(options.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(options.mdOut, markdown);
  return { report, markdown };
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      const { report } = exportFullFeatureReport(options);
      process.stdout.write(
        `FULL_FEATURE_USER_REPORT id=${report.reportId} positive=${report.summary.categories.positive_pass} ` +
          `negative=${report.summary.categories.negative_boundary} harness_invalid=${report.summary.categories.harness_invalid} ` +
          `historical_pass=${report.summary.categories.historical_pass} historical_failure=${report.summary.categories.historical_failure} ` +
          `business=${report.domainConclusions.businessFunction.passed}/${report.domainConclusions.businessFunction.total} ` +
          `output_quality=${report.domainConclusions.employeeOutputQuality.qualityPassed}/${report.domainConclusions.employeeOutputQuality.distinctAuditedEmployees} ` +
          `product_failure=${report.summary.categories.product_failure} ` +
          `safety_not_executed=${report.summary.categories.safety_not_executed} json=${options.jsonOut} md=${options.mdOut}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`FULL_FEATURE_USER_REPORT_ERROR ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { parseArgs, readJsonWithMeta, usage };
