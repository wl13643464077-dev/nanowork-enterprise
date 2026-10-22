#!/usr/bin/env node
/**
 * Random 5 digital-employee sample against the confirmed 北京大鸭梨烤鸭 pack.
 * Writes one parent Desktop folder; each employee gets 01输入 / 02输出 / 03打分.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const restaurantCatalog = require("../server/catalog/restaurant.json");
const contentCatalog = require("../server/catalog/content-crew.json");

const BASE = process.env.NANOWORK_BASE_URL || "http://127.0.0.1:3110";
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
  path.join(os.homedir(), "Desktop", `纳米Work-大鸭梨知识库抽测-随机五岗-${STAMP}`);

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
const PLATFORM_STAMP = /Nano\s*Work\s*企业|纳米\s*Work企业|纳米Work企业版本/iu;

const PRIMARY = {
  101: "比较两个候选商圈，判断哪个品类机会更值得用90天验证",
  102: "画清目标门店3公里商圈与竞品空白，给出可核验的客群画像",
  103: "验证新品牌概念是否真正匹配目标顾客与消费场景",
  104: "对候选铺位评分，并测算租约压力与保本客流",
  108: "精简当前菜单并重做品类、价格梯度、套餐和渠道组合",
  109: "把招牌菜整理成可培训、可复算、可追溯的标准菜品卡",
  111: "按最新配方与采购价重算菜品成本，并给出各渠道售价建议",
  133: "把迎宾到送客的前厅服务做成可培训、可检查的SOP",
  140: "统一品牌语调并改写菜单菜名、卖点和外卖渠道文案",
  141: "制定未来90天本地营销日历，并与预算、产能和经营目标对齐",
  142: "规划下月社媒内容与UGC授权流程，明确每条内容的目标和素材",
  143: "分析近30天差评主题，起草回复并转成门店整改任务",
  160: "判断本店是否适合中秋后到国庆家庭宴并形成可落地活动方案和物料图",
};

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

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function restaurantByIdx(idx) {
  return restaurantCatalog.employees.find((item) => Number(item.idx) === Number(idx));
}

function contentByIdx(idx) {
  return (contentCatalog.employees || contentCatalog.roster || []).find(
    (item) => Number(item.idx) === Number(idx),
  ) || { idx, name: `内容岗${idx}`, person: "", group: "内容团队" };
}

function pickCases() {
  const only = String(process.env.DAYALI_ONLY || "")
    .split(/[,\s]+/u)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
  if (only.length) {
    return only.map((idx) => {
      if (idx < 100) {
        const contentEmp = contentByIdx(idx);
        return {
          id: `content-${idx}`,
          kind: "content",
          idx,
          name: contentEmp.name || `内容${idx}`,
          person: contentEmp.person || "",
          group: contentEmp.group || "内容团队",
          question: questionForContent(idx, contentEmp),
        };
      }
      const emp = restaurantByIdx(idx);
      return {
        id: `restaurant-${idx}`,
        kind: "restaurant",
        idx,
        name: emp?.name || `餐饮${idx}`,
        person: emp?.person || "",
        group: emp?.group || "",
        question: questionForRestaurant(idx, emp),
      };
    });
  }
  const location = shuffle([102, 104])[0];
  const menu = shuffle([108, 109, 111])[0];
  const ops = shuffle([133, 160])[0];
  const brand = shuffle([140, 141, 142, 143])[0];
  const content = 8;
  const picked = [location, menu, ops, brand];
  if (!picked.includes(104)) picked[0] = 104;
  if (!picked.includes(160)) picked[2] = 160;
  const restaurantCases = [...new Set(picked)].slice(0, 4).map((idx) => {
    const emp = restaurantByIdx(idx);
    return {
      id: `restaurant-${idx}`,
      kind: "restaurant",
      idx,
      name: emp?.name || `餐饮${idx}`,
      person: emp?.person || "",
      group: emp?.group || "",
      question: questionForRestaurant(idx, emp),
    };
  });
  const contentEmp = contentByIdx(content);
  const contentCase = {
    id: `content-${content}`,
    kind: "content",
    idx: content,
    name: contentEmp.name || `内容${content}`,
    person: contentEmp.person || "",
    group: contentEmp.group || "内容团队",
    question: questionForContent(content, contentEmp),
  };
  return [...restaurantCases, contentCase];
}

function kbRule() {
  return "必须调用已入库的北京大鸭梨烤鸭品牌知识包（1997创立、十六字理念、口号愿景、节庆打法、招牌香酥烤鸭、官网视觉）。禁止编造未在知识库出现的折扣价格；没有公开价就标待核验。对外店名只能写北京大鸭梨烤鸭，禁止写成平台产品名或租户占位企业名。";
}

function questionForRestaurant(idx, emp) {
  const name = emp?.name || `岗位${idx}`;
  const map = {
    102: `北京大鸭梨烤鸭朝阳门店，请画清门店周边3公里烤鸭/北京菜商圈与竞品空白，给出可核验客群画像。高德如果缺同品类，必须用关键字搜索或公开网页补回来，不要把缺失表交给老板。${kbRule()}`,
    104: `北京大鸭梨烤鸭计划在北京市朝阳区酒仙桥看一个临街铺。请按选址岗位判断是否适合开大鸭梨新店，写清同类烤鸭竞品、客流和租金压力。高德周边如果抓不到烤鸭店，必须启动关键字搜索和其他能力补采，不要满篇“—”。不要编造未核验租金。${kbRule()}`,
    108: `北京大鸭梨烤鸭现有菜单要做家庭宴和堂食+外卖组合。请按菜单架构岗位重做品类、价格梯度和套餐建议；未核验价格一律标待核验。${kbRule()}`,
    109: `请把北京大鸭梨烤鸭招牌香酥烤鸭整理成可培训、可复算的标准菜品卡，只使用知识包已确认卖点，不要编造克重和成本数字。${kbRule()}`,
    111: `请按北京大鸭梨烤鸭招牌香酥烤鸭做菜品成本卡与各渠道售价建议。没有入库的采购价就标待核验，不要编造。${kbRule()}`,
    133: `北京大鸭梨烤鸭朝阳门店要把迎宾到送客做成可培训前厅SOP，语气和待客标准必须贴合知识包里的理念与口号。${kbRule()}`,
    140: `请统一北京大鸭梨烤鸭品牌语调，改写招牌香酥烤鸭的菜单菜名、卖点和外卖文案。必须用知识包口号和理念，不要编造折扣。${kbRule()}`,
    141: `请给北京大鸭梨烤鸭制定2026年10-12月本地营销日历，对齐国庆后家庭宴、年夜饭预热和知识包节庆打法。不要编造未核验折扣。${kbRule()}`,
    142: `请规划北京大鸭梨烤鸭下月社媒内容，明确每条目标、素材和UGC授权。必须用知识包故事、理念和香酥烤鸭，不要编造价格。${kbRule()}`,
    143: `假设北京大鸭梨烤鸭近30天差评集中在等位和片鸭手法。请起草回复并转成门店整改任务，回复语气必须符合知识包待客理念。${kbRule()}`,
    160: `北京大鸭梨烤鸭朝阳门店要做中秋后到国庆的家庭宴活动。请按超级店长给出活动目标、玩法、SOP、物料与执行表，并生成效果图。效果图必须先读取品牌知识包里的 Logo 与视觉调性，理解后再图生图，把标志、店名和活动内容设计进画面；禁止后期硬贴系统字。店名必须是北京大鸭梨烤鸭。${kbRule()}`,
  };
  return map[idx] || `请按${name}岗位，为北京大鸭梨烤鸭完成：${PRIMARY[idx] || name}。${kbRule()}`;
}

function questionForContent(idx, emp) {
  const map = {
    3: `北京大鸭梨烤鸭周五要推香酥烤鸭家庭宴。请写一篇可直接发的种草文案，必须调用已入库品牌知识包的理念、口号和品牌故事，不要编造价格或买赠。`,
    8: `北京大鸭梨烤鸭周五要推香酥烤鸭双人套餐。请写小红书标题、正文、话题和评论区互动。必须调用已入库品牌知识包的理念、口号、品牌故事和节庆打法；不要编造价格、买赠或折扣。`,
    11: `北京大鸭梨烤鸭主打香酥烤鸭，请按正式种草员写小红书标题、正文、标签、首评和配图方案。必须使用已入库品牌知识包，不要编造价格。`,
  };
  return map[idx] || `请按${emp?.name || "内容岗"}为北京大鸭梨烤鸭完成一版可发布内容。${kbRule()}`;
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
  const marker = /品牌知识包|优先匹配|dayalihome|诚实信用|鸭梨味|北京大鸭梨/;
  const hits = FACTS.filter((fact) => fact.re.test(hay)).map((fact) => fact.id);
  return { marker: marker.test(hay), hits, count: hits.length };
}

function campaignItems(done, text) {
  const fromDone = done?.campaignMaterials?.items || done?.campaignMaterials || [];
  if (Array.isArray(fromDone) && fromDone.length) return fromDone;
  const match = String(text || "").match(/```nanowork-campaign-materials\s*\n([\s\S]*?)```/u);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function scoreableText(item, done, dumped) {
  const body = [
    done?.output_body,
    done?.resultMd,
    done?.draft?.body,
    done?.resultPreview,
  ].filter(Boolean).join("\n");
  if (String(body || "").replace(/\s+/g, "").length >= 80) return body;
  return String(dumped || "").replace(item?.question || "", "");
}

function scoreCase(item, text, extra = {}) {
  const loaded = kbLoaded(text);
  const invented = PRICE_INVENTION.test(String(text || "")) && !/待核验|未核验|公开未确认/.test(String(text || ""));
  const complete = String(text || "").replace(/\s+/g, "").length >= 400;
  const stamped = PLATFORM_STAMP.test(String(text || ""));
  const missingHeavy = (String(text || "").match(/\| — \|/g) || []).length >= 8;
  const hasDuckCompetitors = /四季民福|全聚德|便宜坊|大鸭梨烤鸭|酒仙桥.{0,16}烤鸭|烤鸭.{0,16}酒仙桥/u.test(String(text || ""));
  const materials = extra.materials || [];
  const overlayOk = materials.some((row) => /图生图|理解|品牌调性|Logo|北京大鸭梨|家庭宴/u.test(`${row.note || ""} ${row.title || ""}`));
  let score = 0;
  const notes = [];
  if (loaded.marker || loaded.count >= 2) {
    score += 30;
    notes.push(`知识库命中：${loaded.hits.join("、") || "品牌标记"}`);
  } else {
    notes.push("未检出品牌知识包或大鸭梨核验事实");
  }
  if (loaded.hits.includes("愿景口号") || loaded.hits.includes("官网Logo") || loaded.hits.includes("十六字理念")) {
    score += 15;
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
  if (!stamped) {
    score += 10;
    notes.push("未见把店名锁成平台产品名");
  } else {
    notes.push("正文或物料仍出现平台产品名");
  }
  if (item.idx === 104 || item.idx === 102) {
    if (hasDuckCompetitors && !missingHeavy) {
      score += 10;
      notes.push("同品类/商圈不是缺失表");
    } else {
      notes.push("选址/商圈仍偏缺失或未出现烤鸭竞品");
    }
  } else if (item.idx === 160) {
    if (materials.length && overlayOk) {
      score += 10;
      notes.push(`物料${materials.length}张，已按Logo/调性图生图`);
    } else if (materials.length) {
      score += 5;
      notes.push(`出了${materials.length}张物料，但叠字/Logo痕迹不足`);
    } else {
      notes.push("未拿到活动效果图");
    }
  } else if (loaded.count >= 3) {
    score += 10;
    notes.push("核验事实覆盖较全");
  }
  if (extra.failed) {
    score = Math.min(score, 35);
    notes.push(`执行失败：${extra.failed}`);
  }
  return {
    name: `${item.person ? `${item.person}·` : ""}${item.name}`,
    score: Math.min(100, score),
    loaded,
    invented,
    complete,
    stamped,
    notes,
  };
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

function folderName(index, item) {
  const seq = String(index + 1).padStart(2, "0");
  const person = item.person || "数字员工";
  return `${seq}-${item.id}-${person}-${item.name}`.replace(/[\\/:*?"<>|]/g, "");
}

async function ensureBrandPack() {
  let overview = await api("/brand-kb");
  writeFile("raw/brand-kb.json", redact(overview));
  const pack = overview.pack;
  if (String(pack?.brandName || "").includes("大鸭梨") && pack?.status === "ready") return pack;
  if (String(pack?.brandName || "").includes("大鸭梨") && pack?.status === "review") {
    const confirmed = await api("/brand-kb/confirm", { method: "POST", timeoutMs: 60_000 });
    return confirmed.pack || confirmed;
  }
  throw new Error(`品牌知识包未就绪：${pack?.brandName || "?"} / ${pack?.status || "?"}`);
}

async function runRestaurant(item) {
  const created = await api(`/employee-workbench/restaurant/${item.idx}/dispatch`, {
    method: "POST",
    body: { question: item.question },
    timeoutMs: 60_000,
  });
  const taskId = created.taskId;
  const done = await poll(item.id, () => api(`/marshals/tasks/${taskId}/status`), {
    timeoutMs: item.idx === 160 ? 40 * 60_000 : 22 * 60_000,
  });
  const text = scoreableText(item, done, [
    done.output_body,
    done.resultMd,
    done.draft?.body,
  ].join("\n"));
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
  const text = scoreableText(item, done, [done.resultMd, done.resultPreview].join("\n"));
  return { created, done, text, id: runId };
}

async function downloadMaterials(folder, items) {
  const saved = [];
  for (const [index, item] of items.entries()) {
    const url = item?.url;
    if (!url || item.status !== "succeeded") continue;
    const href = url.startsWith("http") ? url : `${BASE}${url}`;
    try {
      const res = await fetch(href, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) continue;
      const name = `${String(index + 1).padStart(2, "0")}-${item.id || item.kind || "material"}.png`;
      const rel = path.join(folder, "物料", name);
      writeFile(rel, buf);
      saved.push({ ...item, file: rel });
    } catch {
      saved.push({ ...item, file: "" });
    }
  }
  return saved;
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
  const cases = pickCases();
  writeFile(
    "raw/picked.json",
    JSON.stringify(
      cases.map((item) => ({ id: item.id, name: item.name, person: item.person, group: item.group })),
      null,
      2,
    ),
  );

  const results = [];
  for (const [index, item] of cases.entries()) {
    process.stderr.write(`[run] ${item.id} ${item.person} ${item.name}\n`);
    const folder = folderName(index, item);
    try {
      const executed = item.kind === "restaurant" ? await runRestaurant(item) : await runContent(item);
      writeFile(`raw/${item.id}.json`, redact({ created: executed.created, done: executed.done }));
      const materials = campaignItems(executed.done, executed.text);
      const savedMaterials = await downloadMaterials(folder, materials);
      const scored = scoreCase(item, executed.text, {
        materials: savedMaterials,
        failed: /失败|failed/i.test(String(executed.done?.status || ""))
          ? executed.done?.error || executed.done?.status
          : "",
      });
      const row = { item, folder, ...executed, materials: savedMaterials, scored };
      writeEmployeeFolder(row, pack);
      results.push(row);
    } catch (error) {
      writeFile(`raw/${item.id}-error.json`, redact({ message: error.message, payload: error.payload, last: error.last }));
      const row = {
        item,
        folder,
        text: String(error.last ? flattenText(error.last) : error.message),
        done: error.last || { status: "失败", error: error.message },
        materials: [],
        scored: scoreCase(item, error.message, { failed: error.message }),
      };
      writeEmployeeFolder(row, pack);
      results.push(row);
    }
  }

  const avg = Math.round(results.reduce((sum, row) => sum + row.scored.score, 0) / results.length);
  writeFile(
    path.join("00总评", "总评.md"),
    [
      `# 北京大鸭梨烤鸭知识库 · 随机五岗抽测`,
      ``,
      `- 综合均分：**${avg}** / 100`,
      `- 环境：${BASE}`,
      `- 账号：${USERNAME}（密码不写入报告）`,
      `- 品牌知识包：${pack.brandName} · ${pack.status} · 版本 ${pack.version || "n/a"} · kbDocId ${pack.kbDocId || pack.kb_doc_id || "n/a"}`,
      `- 抽选规则：选址/商圈、菜单、超级店长、品牌增长、内容岗各随机一岗；为保证刚修的店名/Logo/高德三项能复验，选址固定 104、活动物料固定 160。`,
      ``,
      `| 序号 | 数字员工 | 分数 | 知识库命中 | 备注 |`,
      `| --- | --- | --- | --- | --- |`,
      ...results.map(
        (row, index) =>
          `| ${index + 1} | ${row.item.person}·${row.item.name} | ${row.scored.score} | ${row.scored.loaded.hits.join("、") || "无"} | ${row.scored.notes.join("；")} |`,
      ),
      ``,
      `评分：知识库 30；理念/口号/Logo 15；未编造价格 15；正文完整 15；店名未锁平台 10；岗位专项（竞品补采或物料叠字）10。失败封顶 35。`,
      ``,
      `每个数字员工单独文件夹：\`01输入.md\` / \`02输出.md\` / \`03打分.md\`；超级店长效果图在 \`物料/\`。`,
      ``,
      `目录：${OUT_DIR}`,
      ``,
    ].join("\n"),
  );
  process.stdout.write(`${OUT_DIR}\nAVG=${avg}\n`);
}

function writeEmployeeFolder(row, pack) {
  const { item, folder, scored, done, text, materials } = row;
  writeFile(
    path.join(folder, "01输入.md"),
    [
      `# 01 输入 · ${item.person}·${item.name}`,
      ``,
      `- 岗位：${item.id} / ${item.group || "n/a"}`,
      `- 品牌知识包：${pack.brandName} · ${pack.status}`,
      `- 要求：必须加载北京大鸭梨烤鸭知识库，禁止编造未核验价格`,
      ``,
      `## 派活原文`,
      ``,
      item.question,
      ``,
    ].join("\n"),
  );
  writeFile(
    path.join(folder, "02输出.md"),
    [
      `# 02 输出 · ${item.person}·${item.name}`,
      ``,
      `- 状态：${done?.displayStatus || done?.status || "未知"}`,
      `- 记录：${row.id || "n/a"}`,
      `- 知识库命中：${scored.loaded.hits.join("、") || "无"}`,
      materials.length ? `- 物料：${materials.length} 张，见本文件夹 \`物料/\`` : "",
      ``,
      String(text || "").slice(0, 40000) || "（无正文）",
      ``,
    ].filter((line) => line !== "").join("\n"),
  );
  writeFile(
    path.join(folder, "03打分.md"),
    [
      `# 03 打分 · ${item.person}·${item.name}`,
      ``,
      `分数：**${scored.score}** / 100`,
      ``,
      `- 知识库命中：${scored.loaded.hits.join("、") || "无"}`,
      `- 正文完整：${scored.complete ? "是" : "否"}`,
      `- 疑似编造价格：${scored.invented ? "是" : "否"}`,
      `- 锁成平台产品名：${scored.stamped ? "是" : "否"}`,
      ``,
      ...scored.notes.map((note) => `- ${note}`),
      ``,
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
