// 设计 token 落地率门禁：只允许下降，不允许上升。
// 用法：node scripts/check-tokens.mjs        （超出基线退出码 1）
//       node scripts/check-tokens.mjs --update  （改进后重新锁定基线）
//
// 为什么需要这个：theme.css 从 2026-07 起就写着「业务代码禁止硬编码颜色/字号/圆角/阴影」，
// 但没有任何执法机制，结果 token 落地率约 1.5%——规矩存在却全员绕过。
// 棘轮门禁（ratchet）比一次性大扫除更现实：存量慢慢还，增量当场拦。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "web/src");
const BASELINE_FILE = path.join(root, "scripts/token-baseline.json");

// theme.css 规定的字号档位；小数字号与 <12px 正文一律违规
const ALLOWED_FONT_SIZES = new Set([12, 13, 14, 16, 20, 24, 32]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const metrics = {
  inlineStyle: 0,
  hardcodedHex: 0,
  hardcodedFontSize: 0,
  offScaleFontSize: 0,
  tokenRefs: 0,
};
const offScaleDetail = new Map();

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file).split(path.sep).join("/");
  const isTsx = file.endsWith(".tsx");

  if (isTsx) {
    metrics.inlineStyle += (src.match(/style=\{\{/g) || []).length;
    metrics.hardcodedHex += (src.match(/#[0-9a-fA-F]{6}\b/g) || []).length;

    for (const m of src.matchAll(/fontSize: *(\d+(?:\.\d+)?)/g)) {
      metrics.hardcodedFontSize++;
      const size = Number(m[1]);
      if (!ALLOWED_FONT_SIZES.has(size)) {
        metrics.offScaleFontSize++;
        const key = `${size}px`;
        if (!offScaleDetail.has(key))
          offScaleDetail.set(key, { count: 0, files: new Set() });
        const entry = offScaleDetail.get(key);
        entry.count++;
        entry.files.add(rel);
      }
    }
  }

  metrics.tokenRefs += (
    src.match(/var\(--(?:space|font|radius|dur|shadow|ease)-/g) || []
  ).length;
}

if (process.argv.includes("--update")) {
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log("✅ 基线已更新：");
  console.log(JSON.stringify(metrics, null, 2));
  process.exit(0);
}

if (!fs.existsSync(BASELINE_FILE)) {
  console.error(
    `❌ 缺少基线文件 ${path.relative(root, BASELINE_FILE)}，请先运行：node scripts/check-tokens.mjs --update`,
  );
  process.exit(2);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));

// 越少越好的指标（棘轮只允许下降）
const LOWER_IS_BETTER = [
  "inlineStyle",
  "hardcodedHex",
  "hardcodedFontSize",
  "offScaleFontSize",
];
// 越多越好的指标（棘轮只允许上升）
const HIGHER_IS_BETTER = ["tokenRefs"];

const LABELS = {
  inlineStyle: "内联 style={{}}",
  hardcodedHex: "硬编码 hex 颜色",
  hardcodedFontSize: "硬编码 fontSize",
  offScaleFontSize: "越档字号（非 12/13/14/16/20/24/32）",
  tokenRefs: "token 引用数",
};

let failed = 0;
const improved = [];
console.log("设计 token 落地率门禁\n");
for (const key of [...LOWER_IS_BETTER, ...HIGHER_IS_BETTER]) {
  const now = metrics[key];
  const base = baseline[key] ?? 0;
  const better = LOWER_IS_BETTER.includes(key) ? now <= base : now >= base;
  const delta = now - base;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  const mark = better ? (delta === 0 ? "  " : "✅") : "❌";
  console.log(
    `${mark} ${LABELS[key].padEnd(34)} ${String(now).padStart(6)}  (基线 ${base}, ${sign})`,
  );
  if (!better) failed++;
  else if (delta !== 0) improved.push(key);
}

if (offScaleDetail.size) {
  const top = [...offScaleDetail.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8);
  console.log("\n越档字号 top:");
  for (const [size, info] of top) {
    console.log(
      `  ${size.padEnd(8)} ×${String(info.count).padStart(4)}  ${[...info.files].slice(0, 2).join(", ")}`,
    );
  }
}

if (failed) {
  console.error(
    `\n❌ ${failed} 项指标劣化。请改用 web/src/theme.css 的 token，或在确有必要时说明理由并运行 --update 重锁基线。`,
  );
  process.exit(1);
}

if (improved.length) {
  console.log(
    `\n✅ 全部达标，且 ${improved.length} 项已改善。收紧基线：node scripts/check-tokens.mjs --update`,
  );
} else {
  console.log("\n✅ 全部达标。");
}
