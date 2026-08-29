#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { apiRoutes } from "./build-full-feature-inventory.mjs";
import { runProbeBatch } from "./lib/full-api-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE_URL = "http://127.0.0.1:3107";
const DEFAULT_TIMEOUT_MS = 15_000;

function datedOutput(mode, extension) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(
    ROOT,
    "artifacts",
    `full-api-probe-${mode}-${date}.${extension}`,
  );
}

export function usage() {
  return `NanoWork 全接口可复跑探针

用法：
  NANOWORK_PROBE_USERNAME=USER NANOWORK_PROBE_PASSWORD='***' \\
    node scripts/run-full-api-probe.mjs --mode get|write [选项]

选项：
  --mode get|write          GET 只读巡检或 WRITE 写接口边界巡检（必填）
  --base-url URL            服务地址（默认 ${DEFAULT_BASE_URL}）
  --username USER           登录账号；推荐使用 NANOWORK_PROBE_USERNAME
  --password VALUE          登录密码；推荐使用 NANOWORK_PROBE_PASSWORD
  --out-json FILE           完整 JSON 报告路径
  --out-md FILE             人类可读 Markdown 报告路径
  --timeout-ms N            单请求超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）
  --allow-write             明确允许写探针；WRITE 模式必填
  --isolated-marker TEXT    隔离数据库标识；WRITE 模式必填且必须包含 isolated
  --help                    显示帮助

安全约束：
  优先用环境变量提供凭据，避免进入 shell history 或进程参数列表。
  WRITE 模式必须同时提供 --allow-write 与 isolated 标识。每个受保护写接口使用
  独立登录会话；可能发送消息、付费、发布或调用外部供应商的动作只登记、不发送。
  负向权限/参数边界单独统计，绝不会计入“正向功能通过”。
`;
}

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} 缺少参数值`);
  return value;
}

export function parseArgs(argv, env = process.env) {
  const values = {
    mode: "",
    baseUrl: DEFAULT_BASE_URL,
    username: String(env.NANOWORK_PROBE_USERNAME || ""),
    password: String(env.NANOWORK_PROBE_PASSWORD || ""),
    outJson: "",
    outMd: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowWrite: false,
    isolatedMarker: "",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      values.help = true;
      continue;
    }
    if (option === "--allow-write") {
      values.allowWrite = true;
      continue;
    }
    const value = requiredValue(argv, index, option);
    index += 1;
    if (option === "--mode") values.mode = value.toLowerCase();
    else if (option === "--base-url") values.baseUrl = value;
    else if (option === "--username") values.username = value;
    else if (option === "--password") values.password = value;
    else if (option === "--out-json") values.outJson = value;
    else if (option === "--out-md") values.outMd = value;
    else if (option === "--timeout-ms") values.timeoutMs = Number(value);
    else if (option === "--isolated-marker") values.isolatedMarker = value;
    else throw new Error(`未知参数：${option}`);
  }

  if (values.help) return values;
  if (!new Set(["get", "write"]).has(values.mode))
    throw new Error("--mode 必须是 get 或 write");
  if (!values.username.trim())
    throw new Error(
      "缺少登录账号：请提供 --username 或 NANOWORK_PROBE_USERNAME",
    );
  if (!values.password)
    throw new Error(
      "缺少登录密码：请提供 --password 或 NANOWORK_PROBE_PASSWORD",
    );
  if (
    !Number.isInteger(values.timeoutMs) ||
    values.timeoutMs < 250 ||
    values.timeoutMs > 300_000
  ) {
    throw new Error("--timeout-ms 必须是 250 到 300000 之间的整数");
  }
  let parsedBase;
  try {
    parsedBase = new URL(values.baseUrl);
  } catch {
    throw new Error("--base-url 必须是有效的 HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsedBase.protocol))
    throw new Error("--base-url 只支持 HTTP(S)");
  if (parsedBase.username || parsedBase.password)
    throw new Error("--base-url 不得包含账号或密码");
  if (parsedBase.search || parsedBase.hash)
    throw new Error("--base-url 不得包含查询参数或片段");
  values.baseUrl = parsedBase.href.replace(/\/$/u, "");

  if (values.mode === "write") {
    if (!values.allowWrite)
      throw new Error("WRITE 模式必须显式提供 --allow-write");
    if (!/isolated/iu.test(values.isolatedMarker)) {
      throw new Error(
        "WRITE 模式必须提供包含 isolated 的 --isolated-marker，且只能连接隔离数据库副本",
      );
    }
  }

  values.outJson = path.resolve(
    values.outJson || datedOutput(values.mode, "json"),
  );
  values.outMd = path.resolve(values.outMd || datedOutput(values.mode, "md"));
  if (values.outJson === values.outMd)
    throw new Error("--out-json 与 --out-md 必须是不同文件");
  return values;
}

function requestErrorBody(error) {
  return JSON.stringify({
    error: `transport failure: ${String(error?.message || error)}`,
  });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createProbeClient(config, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function")
    throw new Error("当前 Node.js 环境不支持 fetch");
  const baseUrl = config.baseUrl.replace(/\/$/u, "");

  return {
    async login() {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/api/auth/login`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            username: config.username,
            password: config.password,
          }),
        },
        config.timeoutMs,
      );
      const rawBody = await response.text();
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = null;
      }
      if (!response.ok || !payload?.token) {
        const message = String(payload?.error || "响应未返回 token")
          .replace(/\s+/gu, " ")
          .slice(0, 180);
        throw new Error(`登录失败（HTTP ${response.status}）：${message}`);
      }
      return {
        token: payload.token,
        role: payload.user?.role || null,
        tenantId: payload.user?.tenant?.id ?? payload.user?.tenant_id ?? null,
      };
    },

    async request({ method, url, body, token }) {
      const headers = {
        accept: "application/json, text/plain;q=0.9, */*;q=0.1",
      };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          url,
          {
            method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          },
          config.timeoutMs,
        );
        return {
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          rawBody: await response.text(),
        };
      } catch (error) {
        return {
          status: 0,
          contentType: "application/json",
          rawBody: requestErrorBody(error),
        };
      }
    },
  };
}

export function selectRoutes(routes, mode) {
  const selected = routes.filter((row) =>
    mode === "get"
      ? String(row.method).toUpperCase() === "GET"
      : String(row.method).toUpperCase() !== "GET",
  );
  const unique = new Map();
  for (const row of selected)
    unique.set(`${String(row.method).toUpperCase()}:${row.path}`, row);
  return [...unique.values()];
}

function markdownCell(value, limit = 900) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  const compact = text.replace(/\r?\n/gu, " ").replace(/\|/gu, "\\|");
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function verdictLabel(result) {
  if (result.quality?.happyPathPass) return "正向功能通过";
  const labels = {
    NEGATIVE_BOUNDARY_PASS: "负向边界通过（不代表正向功能通过）",
    SAFETY_NOT_EXECUTED: "安全阻断（未发送）",
    AUTH_HARNESS_FAILURE: "测试器认证失效（本接口未验证）",
    FIXTURE_INVALID: "测试输入无效（本接口未验证）",
    ROUTE_DISCOVERY_INVALID: "路由清单无效（本接口未验证）",
    UNVERIFIED: "尚未验证（2xx 未证明目标意图）",
    TRANSPORT_FAILURE: "传输失败",
    PRODUCT_SERVER_FAILURE: "接口探针发现服务端失败",
    PRODUCT_OR_FIXTURE_FAILURE: "接口探针失败或测试输入未覆盖",
  };
  return (
    labels[result.quality?.verdict] ||
    String(result.quality?.verdict || "未验证")
  );
}

export function renderMarkdown(report, config) {
  const rows = report.results || [];
  const productFailures = rows.filter(
    (row) => row.quality?.coverageClass === "产品失败",
  ).length;
  const lines = [
    `# NanoWork ${config.mode === "write" ? "WRITE 写接口" : "GET 只读接口"}真实探针报告`,
    "",
    `- 生成时间：${report.summary.generatedAt}`,
    `- 服务地址：${report.summary.base}`,
    `- 接口总数：${report.summary.total}`,
    `- 正向功能通过：${report.summary.happyPathPass || 0}`,
    `- 负向边界通过：${report.summary.negativeBoundaryPass || 0}（只证明权限/参数/不存在资源边界，不计入正向通过）`,
    `- 安全阻断未发送：${report.summary.safetyNotExecuted || 0}`,
    `- 尚未验证：${report.summary.unverified || 0}`,
    `- 测试器无效：${report.summary.invalidHarness || 0}`,
    `- 接口探针失败：${productFailures}（仅指本轮 HTTP 接口探针）`,
    ...(config.mode === "write"
      ? [`- 隔离数据库标识：${report.summary.dbMarker}`]
      : []),
    "",
    "> 质量口径：只有 happy_path 意图、符合接口契约的输入、2xx 响应且无业务失败语义，才计为“正向功能通过”。负向边界与尚未验证单独列示，绝不冒充正向成功。",
    "> 覆盖边界：本报告只覆盖本轮 HTTP 接口探针；不代表完整业务流程、数字员工真实交付或外部供应商的全局状态。",
    "",
    "## 每个接口的输入、输出与质量",
    "",
    "| ID / 路由 | 输入 | 输出 | 质量结论 |",
    "|---|---|---|---|",
  ];
  for (const row of rows) {
    const quality = {
      verdict: row.quality?.verdict || null,
      label: verdictLabel(row),
      score: row.quality?.score ?? null,
      happyPathPass: row.quality?.happyPathPass === true,
      reachedTargetHandler: row.quality?.reachedTargetHandler === true,
      authRecoveryCount: row.quality?.authRecoveryCount || 0,
    };
    lines.push(
      `| ${markdownCell(`${row.id} · ${row.route}`)} | ${markdownCell(row.input)} | ${markdownCell(row.output)} | ${markdownCell(quality)} |`,
    );
  }
  lines.push("", "完整、可机器复核的字段保存在同名 JSON 报告中。", "");
  return lines.join("\n");
}

export function writeReports(report, config) {
  fs.mkdirSync(path.dirname(config.outJson), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(config.outMd), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.outJson, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(config.outMd, renderMarkdown(report, config), {
    mode: 0o600,
  });
}

export async function runConfiguredProbe(config, dependencies = {}) {
  const allRoutes =
    dependencies.routes || (await (dependencies.routesProvider || apiRoutes)());
  const routes = selectRoutes(allRoutes, config.mode);
  const client =
    dependencies.client || createProbeClient(config, dependencies.fetchImpl);
  const runBatch = dependencies.runProbeBatch || runProbeBatch;
  if (typeof runBatch !== "function")
    throw new Error("runProbeBatch 未从探针库导出");
  const report = await runBatch({
    mode: config.mode,
    routes,
    baseUrl: config.baseUrl,
    login: client.login,
    request: client.request,
    allowWriteProbes: config.allowWrite,
    isolatedDbMarker: config.isolatedMarker,
  });
  return {
    ...report,
    invocation: {
      mode: config.mode,
      discoveredRoutes: allRoutes.length,
      selectedRoutes: routes.length,
      credentialSource: "runtime-only-redacted",
      usernameRecorded: false,
      passwordRecorded: false,
    },
  };
}

export function renderCliSummary(report, config) {
  const productFailures = (report.results || []).filter(
    (row) => row.quality?.coverageClass === "产品失败",
  ).length;
  return (
    [
      `FULL_API_PROBE mode=${config.mode}`,
      "scope=current_http_probe_only",
      "excludes=business_flows,digital_employees,external_providers",
      `total=${report.summary.total}`,
      `happy=${report.summary.happyPathPass || 0}`,
      `negative=${report.summary.negativeBoundaryPass || 0}`,
      `safety=${report.summary.safetyNotExecuted || 0}`,
      `unverified=${report.summary.unverified || 0}`,
      `harness_invalid=${report.summary.invalidHarness || 0}`,
      `probe_failures=${productFailures}`,
      `json=${config.outJson}`,
      `md=${config.outMd}`,
    ].join(" ") + "\n"
  );
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  if (config.help) {
    process.stdout.write(usage());
    return 0;
  }
  const report = await runConfiguredProbe(config);
  writeReports(report, config);
  const productFailures = report.results.filter(
    (row) => row.quality?.coverageClass === "产品失败",
  ).length;
  process.stdout.write(renderCliSummary(report, config));
  return report.summary.invalidHarness > 0 || productFailures > 0 ? 2 : 0;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `FULL_API_PROBE_ERROR ${String(error?.message || error)}\n`,
      );
      process.exitCode = 1;
    });
}
