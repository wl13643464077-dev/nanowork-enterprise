#!/usr/bin/env node
/**
 * Production sample: confirm 北京大鸭梨烤鸭 brand KB, then dispatch
 * restaurant/content employees + toolbox runs that must load it.
 * Writes Desktop 01输入 / 02输出 / 03打分. Never prints passwords or API keys.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.NANOWORK_BASE_URL || "https://xn--work-9r3ko5i.cn";
const USERNAME = process.env.MATRIX_USERNAME || "guan";
const PASSWORD = process.env.MATRIX_PASSWORD || "123456";
const BRAND = "北京大鸭梨烤鸭";
const STAMP = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15);
const OUT_DIR =
  process.env.DAYALI_OUT_DIR ||
  path.join(os.homedir(), "Desktop", `纳米Work-大鸭梨知识库抽测-${STAMP}`);

const FACTS = [
  { id: "成立1997", re: /1997/ },
  { id: "十六字理念", re: /诚实信用|求变创新|服务大众|永争第一|十六字/ },
  { id: "愿景口号", re: /鸭梨味|味天下|客户的满意高于一切/ },
  { id: "官网Logo", re: /dayalihome|logo\.png/i },
  { id: "资质合规", re: /京ICP|绿色食品|食品安全/ },
  { id: "节庆打法", re: /中秋|年夜饭|端午|国庆/ },
  { id: "招牌产品", re: /香酥烤鸭|烤鸭/ },
];

const PRICE_INVENTION =
  /限时\d+元|仅需\d+元|直降\d+|买一送一|第二份半价|折扣\d+折/u;

let token = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer <redacted>")
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"<redacted>"')
    .replace(/password[^,\n]*/gi, "password=<redacted>");
}

function flattenText(value, depth = 0) {
  if (value == null || depth > 8) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item, depth + 1)).join("\n");
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([key]) => !/password|token|authorization|cookie|apiKey|secret/i.test(key))
      .map(([, item]) => flattenText(item, depth + 1))
      .join("\n");
  }
  return "";
}

async function api(pathname, { method = "GET", body, timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api${pathname}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    let json = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      json = { error: raw.slice(0, 800) };
    }
    if (!res.ok) {
      const err = new Error(json.error || json.message || `${res.status} ${pathname}`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function kbLoaded(text) {
  const hay = String(text || "");
  const marker = /品牌知识包|优先匹配|dayalihome|诚实信用|鸭梨味/;
  const hits = FACTS.filter((fact) => fact.re.test(hay)).map((fact) => fact.id);
  return {
    marker: marker.test(hay),
    hits,
    count: hits.length,
  };
}

function scoreCase(name, text, extra = {}) {
  const loaded = kbLoaded(text);
  const invented = PRICE_INVENTION.test(String(text || "")) && !/待核验|未核验|公开未确认/.test(String(text || ""));
  const complete = String(text || "").replace(/\s+/g, "").length >= 400;
  let score = 0;
  const notes = [];
  if (loaded.marker || loaded.count >= 2) {
    score += 40;
    notes.push(`知识库命中：${loaded.hits.join("、") || "品牌知识包标记"}`);
  } else {
    notes.push("未检出品牌知识包或大鸭梨核验事实");
  }
  if (loaded.hits.includes("愿景口号") || loaded.hits.includes("官网Logo") || loaded.hits.includes("十六字理念")) {
    score += 20;
    notes.push("用到理念/口号/Logo");
  }
  if (!invented) {
    score += 15;
    notes.push("未见把未核验折扣价格写成已确认事实");
  } else {
    notes.push("疑似编造折扣/价格");
  }
  if (complete) {
    score += 15;
    notes.push("交付正文完整");
  } else {
    notes.push("交付过短或不完整");
  }
  if (loaded.count >= 4) {
    score += 10;
    notes.push("核验事实覆盖较全");
  } else if (loaded.count >= 1) {
    score += 5;
    notes.push("核验事实覆盖偏少");
  }
  if (extra.failed) {
    score = Math.min(score, 35);
    notes.push(`执行失败：${extra.failed}`);
  }
  return { name, score, loaded, invented, complete, notes };
}

async function poll(label, fetchOnce, { timeoutMs, intervalMs = 8000 }) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchOnce();
    const status = String(last?.status || last?.run?.status || last?.displayStatus || "");
    const done = /已完成|待审阅|失败|已驳回|done|failed|error/i.test(status);
    const generating = /生成中|queued|running|pending|processing/i.test(status);
    if (done && !generating) return last;
    process.stderr.write(`[poll] ${label} ${status || "…"} ${Math.round((Date.now() - start) / 1000)}s\n`);
    await sleep(intervalMs);
  }
  throw Object.assign(new Error(`${label} 超时`), { last });
}

function writeFile(rel, text) {
  const full = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

const CASES = [
  {
    id: "restaurant-160",
    name: "超级店长",
    kind: "restaurant",
    idx: 160,
    question:
      "北京大鸭梨烤鸭朝阳门店要做中秋后到国庆的家庭宴活动。请按超级店长岗位，用已入库的北京大鸭梨烤鸭品牌知识包（创立背景、十六字理念、口号愿景、节庆打法、招牌香酥烤鸭、官网视觉）给出活动目标、玩法、SOP、物料与执行表。禁止编造未在知识库出现的折扣价格；没有公开价就标待核验。",
  },
  {
    id: "restaurant-104",
    name: "选址",
    kind: "restaurant",
    idx: 104,
    question:
      "北京大鸭梨烤鸭计划在北京市朝阳区酒仙桥看一个临街铺。请用已入库品牌知识包里的门店布局、客群、品类和竞品对照，判断这个铺位是否适合开大鸭梨新店，并写清同类竞品、客流和租金压力。不要编造未核验租金和房价。",
  },
  {
    id: "content-8",
    name: "发布文案",
    kind: "content",
    idx: 8,
    question:
      "北京大鸭梨烤鸭周五要推香酥烤鸭双人套餐。请写小红书标题、正文、话题和评论区互动。必须调用已入库品牌知识包的理念、口号、品牌故事和节庆打法；不要编造价格、买赠或折扣。",
  },
  {
    id: "toolbox-bench",
    name: "竞品盯梢",
    kind: "toolbox",
    toolKey: "bench",
    employeeIdx: 102,
    title: "北京大鸭梨烤鸭竞品盯梢",
    inputs: {
      targets: "全聚德（前门/王府井）\n便宜坊\n季景轩",
      period: "近90天",
      focus: "北京大鸭梨烤鸭招牌香酥烤鸭、节庆套餐、家庭宴与口碑关键词，对照已入库品牌知识包，不要编造对方未公开的价格。",
    },
  },
  {
    id: "toolbox-pcal",
    name: "私域日历",
    kind: "toolbox",
    toolKey: "pcal",
    employeeIdx: 141,
    title: "北京大鸭梨烤鸭10月私域日历",
    inputs: {
      month: "2026-10",
      channels: ["微信社群", "视频号", "大众点评"],
      focus: "北京大鸭梨烤鸭国庆与中秋后家庭宴、年夜饭预热。必须使用已入库品牌知识包的节庆打法、口号和招牌产品，不要编造未核验折扣。",
    },
  },
];

async function ensureBrandPack() {
  let overview = await api("/brand-kb");
  writeFile("raw/brand-kb-before.json", redact(overview));
  const pack = overview.pack;
  const sameBrand = String(pack?.brandName || "").includes("大鸭梨");
  if (sameBrand && pack?.status === "ready") {
    return pack;
  }
  if (sameBrand && pack?.status === "review") {
    const confirmed = await api("/brand-kb/confirm", { method: "POST", timeoutMs: 60_000 });
    return confirmed.pack || confirmed;
  }
  process.stderr.write("[brand-kb] collect 北京大鸭梨烤鸭\n");
  let collected;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      collected = await api("/brand-kb/collect", {
        method: "POST",
        body: { brandName: BRAND },
        timeoutMs: 12 * 60_000,
      });
      break;
    } catch (error) {
      if (error.status === 409) {
        process.stderr.write("[brand-kb] 采集进行中，等待后重试\n");
        await sleep(20_000);
        const current = await api("/brand-kb");
        if (current.pack?.status === "review" || current.pack?.status === "ready") {
          collected = current.pack;
          break;
        }
        continue;
      }
      throw error;
    }
  }
  if (!collected) throw new Error("品牌知识包采集未完成");
  writeFile("raw/brand-kb-collected.json", redact(collected));
  const confirmed = await api("/brand-kb/confirm", { method: "POST", timeoutMs: 60_000 });
  overview = await api("/brand-kb");
  writeFile("raw/brand-kb-after.json", redact(overview));
  return confirmed.pack || confirmed || overview.pack;
}

async function runRestaurant(item) {
  const created = await api(`/employee-workbench/restaurant/${item.idx}/dispatch`, {
    method: "POST",
    body: { question: item.question },
    timeoutMs: 60_000,
  });
  const taskId = created.taskId;
  const done = await poll(item.id, () => api(`/marshals/tasks/${taskId}/status`), {
    timeoutMs: 18 * 60_000,
  });
  const text = [
    done.output_body,
    done.resultMd,
    done.draft?.body,
    flattenText(done.executionSnapshot?.kb),
    flattenText(done),
  ].join("\n");
  return { created, done, text, id: taskId };
}

async function runContent(item) {
  const created = await api(`/employee-workbench/content/${item.idx}/dispatch`, {
    method: "POST",
    body: { question: item.question },
    timeoutMs: 60_000,
  });
  const runId = created.runId || created.taskId;
  const done = await poll(
    item.id,
    async () => {
      const data = await api(`/employee-workbench/content/${item.idx}/runs/${runId}`);
      return data.run || data;
    },
    { timeoutMs: 12 * 60_000 },
  );
  const text = [done.resultMd, done.resultPreview, flattenText(done.snapshot), flattenText(done)].join("\n");
  return { created, done, text, id: runId };
}

async function runToolbox(item) {
  const created = await api("/toolbox/runs", {
    method: "POST",
    body: {
      toolKey: item.toolKey,
      employeeIdx: item.employeeIdx,
      title: item.title,
      inputs: item.inputs,
    },
    timeoutMs: 60_000,
  });
  const runId = created.run?.id || created.id;
  const done = await poll(
    item.id,
    async () => {
      const data = await api(`/toolbox/runs/${runId}`);
      return data.run || data;
    },
    { timeoutMs: 12 * 60_000 },
  );
  const text = [done.resultMd, flattenText(done.evidence), flattenText(done)].join("\n");
  return { created, done, text, id: runId };
}

async function main() {
  fs.mkdirSync(path.join(OUT_DIR, "raw"), { recursive: true });
  const login = await api("/auth/login", {
    method: "POST",
    body: { username: USERNAME, password: PASSWORD },
    timeoutMs: 30_000,
  });
  token = login.token;
  if (!token) throw new Error("登录未返回 token");
  const pack = await ensureBrandPack();
  if (!String(pack?.brandName || "").includes("大鸭梨") || pack?.status !== "ready") {
    throw new Error(`品牌知识包未就绪：${pack?.brandName || "?"} / ${pack?.status || "?"}`);
  }

  const results = [];
  for (const item of CASES) {
    process.stderr.write(`[run] ${item.id}\n`);
    try {
      const executed =
        item.kind === "restaurant"
          ? await runRestaurant(item)
          : item.kind === "content"
            ? await runContent(item)
            : await runToolbox(item);
      writeFile(`raw/${item.id}.json`, redact({ created: executed.created, done: executed.done }));
      const scored = scoreCase(item.name, executed.text, {
        failed: /失败|failed/i.test(String(executed.done?.status || ""))
          ? executed.done?.error || executed.done?.status
          : "",
      });
      results.push({ item, ...executed, scored });
    } catch (error) {
      writeFile(`raw/${item.id}-error.json`, redact({ message: error.message, payload: error.payload, last: error.last }));
      results.push({
        item,
        text: String(error.last ? flattenText(error.last) : error.message),
        done: error.last || { status: "失败", error: error.message },
        scored: scoreCase(item.name, error.message, { failed: error.message }),
      });
    }
  }

  const avg = Math.round(results.reduce((sum, row) => sum + row.scored.score, 0) / results.length);
  const inputMd = [
    `# 01 输入`,
    ``,
    `- 环境：${BASE}`,
    `- 账号：${USERNAME}（密码不写入报告）`,
    `- 品牌知识包：${pack.brandName} · 状态 ${pack.status} · 版本 ${pack.version || "n/a"} · kbDocId ${pack.kbDocId || pack.kb_doc_id || "n/a"}`,
    `- 要求：抽测必须加载这次北京大鸭梨烤鸭知识库，禁止编造未核验价格。`,
    ``,
    ...results.flatMap((row) => [
      `## ${row.item.id} · ${row.item.name}`,
      row.item.question
        ? row.item.question
        : "```json\n" + JSON.stringify(row.item.inputs, null, 2) + "\n```",
      ``,
    ]),
  ].join("\n");

  const outputMd = [
    `# 02 输出`,
    ``,
    ...results.flatMap((row) => [
      `## ${row.item.id} · ${row.item.name}`,
      `- 状态：${row.done?.displayStatus || row.done?.status || "未知"}`,
      `- 记录：${row.id || "n/a"}`,
      `- 知识库命中：${row.scored.loaded.hits.join("、") || "无"}`,
      ``,
      String(row.text || "").slice(0, 12000) || "（无正文）",
      ``,
      `---`,
      ``,
    ]),
  ].join("\n");

  const scoreMd = [
    `# 03 打分`,
    ``,
    `综合均分：**${avg}** / 100`,
    ``,
    `| 用例 | 分数 | 知识库命中 | 备注 |`,
    `| --- | --- | --- | --- |`,
    ...results.map(
      (row) =>
        `| ${row.item.name} | ${row.scored.score} | ${row.scored.loaded.hits.join("、") || "无"} | ${row.scored.notes.join("；")} |`,
    ),
    ``,
    `评分规则：知识库命中 40；理念/口号/Logo 20；未编造价格 15；正文完整 15；事实覆盖 10。失败封顶 35。`,
    ``,
    `品牌包确认字段：${JSON.stringify(
      {
        brandName: pack.brandName,
        status: pack.status,
        version: pack.version,
        filled: pack.filledCount || pack.filled,
        kbDocId: pack.kbDocId || pack.kb_doc_id,
      },
      null,
      2,
    )}`,
  ].join("\n");

  writeFile("01输入.md", inputMd);
  writeFile("02输出.md", outputMd);
  writeFile("03打分.md", scoreMd);
  writeFile(
    "00总评.md",
    `# 北京大鸭梨烤鸭知识库抽测\n\n综合均分 ${avg}。知识包 ${pack.brandName} / ${pack.status}。目录：${OUT_DIR}\n`,
  );
  process.stdout.write(`${OUT_DIR}\nAVG=${avg}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
