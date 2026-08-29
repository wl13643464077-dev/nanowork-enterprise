// 多租户隔离自检：扫描所有后端查询，揪出"隔离表主查询缺 tenant_id"的高危点。
// 用法：node scripts/check-isolation.mjs   （建议提交前 / CI 跑；发现高危退出码 1）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["server/src/routes", "server/src/engines"];

// 监控清单单一来源：直接从 db.js 的 ISOLATED 集合解析（自动注入 tenant_id 的表），
// 避免两份手维护清单漂移——正是这种漂移让 V2.10 的 /admin credit_logs/op_logs 聚合泄露漏检。
function parseIsolatedFromDb() {
  const dbSrc = fs.readFileSync(path.join(root, "server/src/db.js"), "utf8");
  const m = dbSrc.match(/const\s+ISOLATED\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
  if (!m) {
    console.error(
      "❌ 无法从 server/src/db.js 解析 ISOLATED 集合，请检查该文件。",
    );
    process.exit(2);
  }
  return [...m[1].matchAll(/(["'])([a-z_]+)\1/g)].map((x) => x[2]);
}
// 额外显式隔离表：带 tenant_id 列但 INSERT 显式传值（不在自动注入集合）。
// credit_logs 是典型——计费流水按租户分账，聚合读必须带 tenant_id，否则跨企业串账（V2.10 实锤）。
const EXTRA_EXPLICIT = [
  "credit_logs",
  // 内容团队流水线由独立 repository 使用显式 tenant_id 建表和读写，
  // 不走 db.js 的 INSERT 自动注入；仍必须纳入静态读隔离审计。
  "content_production_pipeline_jobs",
  "content_production_pipeline_stations",
  "content_production_pipeline_phase_events",
  "content_production_pipeline_artifacts",
  "content_production_pipeline_artifact_backfills",
  "content_production_pipeline_private_web_snapshots",
];
const ISOLATED = [...new Set([...parseIsolatedFromDb(), ...EXTRA_EXPLICIT])];

// 提取从 startIdx 的 ( 起、括号匹配的完整调用文本
function callText(s, openIdx) {
  let d = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") d++;
    else if (s[i] === ")") {
      d--;
      if (d === 0) return s.slice(openIdx, i + 1);
    }
  }
  return s.slice(openIdx);
}

let high = 0,
  review = 0;
const findings = [];
for (const dir of DIRS) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const file of fs.readdirSync(full).filter((f) => f.endsWith(".js"))) {
    const s = fs.readFileSync(path.join(full, file), "utf8");
    // q.all/q.get 之外，部分独立 repository 直接使用 db.prepare；两种读法都审计，
    // 避免“主业务查询已安全、旁路 repository 未被扫描”的假绿。
    const re = /(?:q\.(?:all|get)|db\.prepare)\s*\(/g;
    let m;
    while ((m = re.exec(s))) {
      const call = callText(s, m.index + m[0].length - 1);
      const lower = call.toLowerCase();
      for (const t of ISOLATED) {
        // 主表查询：FROM <t>（FROM 后直接跟隔离表，排除 "JOIN <t>"）
        const mainFrom =
          new RegExp(`from\\s+${t}\\b`, "i").test(call) &&
          !new RegExp(`join\\s+${t}\\b`, "i").test(
            call.replace(new RegExp(`from\\s+${t}\\b`, "i"), ""),
          );
        if (!mainFrom) continue;
        if (/tenant_id|curtenant/i.test(lower)) break; // 已隔离
        // 用 ${where}/${ownerFilter} 动态拼接的，过滤条件在变量里（脚本看不到内容）→ 降为待复核
        // 子查询按外键关联已隔离主表（partner_id/lead_id=…）→ 降为待复核
        const line = s.slice(0, m.index).split("\n").length;
        const relational =
          /\$\{where\}|\$\{ownerFilter\}|\$\{[A-Za-z_$][\w$]*\.where\}/.test(
            call,
          ) ||
          /\b(partner_id|lead_id|activity_id|asset_id|marshal_id|specialist_id|task_id)\s*=/i.test(
            call,
          );
        findings.push({
          file,
          line,
          table: t,
          relational,
          snippet: call.replace(/\s+/g, " ").slice(0, 90),
        });
        if (relational) review++;
        else high++;
        break;
      }
    }
  }
}

console.log(`\n=== 多租户隔离自检 ===`);
console.log(
  `监控 ${ISOLATED.length} 张隔离表（清单自动同步自 db.js 的 ISOLATED 集合 + 显式隔离表 ${EXTRA_EXPLICIT.join("/")}），扫描 ${DIRS.join(" / ")}`,
);
const highs = findings.filter((f) => !f.relational);
const reviews = findings.filter((f) => f.relational);
if (highs.length) {
  console.log(
    `\n🔴 高危（隔离表主查询缺 tenant_id，疑似跨租户泄露）${highs.length} 处：`,
  );
  highs.forEach((f) =>
    console.log(`  ${f.file}:${f.line}  [${f.table}]  ${f.snippet}`),
  );
}
if (reviews.length) {
  console.log(
    `\n🟡 待复核（按外键关联已隔离主表，通常安全）${reviews.length} 处：`,
  );
  reviews.forEach((f) =>
    console.log(`  ${f.file}:${f.line}  [${f.table}]  ${f.snippet}`),
  );
}
if (!findings.length) console.log("✅ 未发现隔离表主查询缺 tenant_id 的情况。");
console.log("");
process.exit(high > 0 ? 1 : 0);
