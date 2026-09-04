// 前端界面契约：用源码扫描锁住 docs/DESIGN.md 的硬约束与结构不变量。
// 用法：node scripts/check-ui-contract.mjs   （违约退出码 1）
//
// 前端没有组件测试框架，参考"选稳定锚点、不钉整行"的做法做源码断言：
// 只锁语义上不该变的东西（禁止文案、巨型文件上限、遗留行业术语），不锁具体实现细节。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "web/src");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// rel 统一为正斜杠：LEGACY_ALLOW / MAX_LINES 的 key 都是 POSIX 风格，
// Windows 下 path.relative 返回反斜杠会让豁免与上限表整体失配（误报术语残留、漏查行数）。
const files = walk(SRC).map((f) => ({
  rel: path.relative(root, f).split(path.sep).join("/"),
  src: fs.readFileSync(f, "utf8"),
}));
const violations = [];

// 存量豁免（技术债台账，非永久许可）：
// 这些文件的旧行业枚举值仍在数据库里，清理需配套读时映射与数据迁移，排在 P4。
// 台账的作用是「增量当场拦、存量不遗忘」——新文件出现同类问题会立刻失败。
const LEGACY_ALLOW = {
  酒水行业术语残留: new Set([
    "web/src/pages/Activities.tsx", // 活动类型枚举 value 仍是旧值，label 已改餐饮口径
    "web/src/pages/Dashboard.tsx", // 引用同一份枚举做标签与配色映射
    "web/src/pages/Execution.tsx", // 合伙人等级「馆主」
  ]),
};

let waived = 0;

function forbid(pattern, label, hint) {
  for (const { rel, src } of files) {
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!pattern.test(line)) return;
      if (LEGACY_ALLOW[label]?.has(rel)) {
        waived++;
        return;
      }
      violations.push({
        rel,
        line: i + 1,
        label,
        hint,
        text: line.trim().slice(0, 100),
      });
    });
  }
}

// —— DESIGN.md 禁止项（已被后端回归测试固化，前端同步锁死）——
forbid(
  /十大元帅|升维智脑|MetaMind|善念利他|各美其美/,
  "DESIGN.md 禁止的旧品牌文案",
  "改用「纳米Work行业版」与老板任务语言",
);
forbid(
  /酒道馆|晋善晋美|shanmei|SHANMEI/i,
  "来源项目品牌残留",
  "主项目不得出现参考项目品牌名",
);

// —— 旧行业术语残留（存库值仍是酒水口径，label 已改餐饮，属未改完的移植痕迹）——
forbid(
  /馆主|封坛仪式|回厂游|品鉴会|沙龙会/,
  "酒水行业术语残留",
  "统一餐饮口径；历史值走后端 LEGACY_*_MAP 读时映射",
);

// —— 诚实化原则：禁止无来源的漂亮数字 ——
forbid(
  /(?<![.\d])99\.9{1,2}%|100%\s*(准确|精准|保证)/,
  "无来源的虚假指标",
  "所有数字必须可追溯来源；无数据显示为空而非估算",
);

// —— 结构不变量 ——
const MAX_LINES = {
  // 现状上限（棘轮：只允许降，拆解进行中）。目标 < 600。
  // 每次拆解后把上限跟着调低，防止一边拆一边长回去。
  "web/src/pages/ContentFactory.tsx": 4890,
  "web/src/pages/System.tsx": 3465,
  "web/src/pages/Activities.tsx": 3310,
  "web/src/pages/Growth.tsx": 2930,
  "web/src/pages/Execution.tsx": 2760,
  "web/src/pages/Dashboard.tsx": 2320,
  "web/src/pages/Admin.tsx": 2155,
};
for (const [rel, max] of Object.entries(MAX_LINES)) {
  const found = files.find((f) => f.rel === rel);
  if (!found) continue;
  const count = found.src.split("\n").length;
  if (count > max) {
    violations.push({
      rel,
      line: count,
      label: "巨型文件行数超上限",
      hint: `当前 ${count} 行 > 上限 ${max}。巨型文件只允许变小；拆解范式见 components/EmployeeWorkbench.tsx`,
      text: "",
    });
  }
}

// —— 新增文件不得再引入全项目已废弃的模式 ——
for (const { rel, src } of files) {
  // CSS 模板字符串注入（第八轮已清零 33KB，不得回归）
  if (/const [A-Z_]*STYLES\s*=\s*`/.test(src)) {
    violations.push({
      rel,
      line:
        src
          .split("\n")
          .findIndex((l) => /const [A-Z_]*STYLES\s*=\s*`/.test(l)) + 1,
      label: "CSS 模板字符串注入回归",
      hint: "样式必须走真实 .css 文件，以便进入构建管线与 stylelint 治理",
      text: "",
    });
  }
}

if (violations.length) {
  console.error(`❌ 前端界面契约违约 ${violations.length} 处：\n`);
  const grouped = new Map();
  for (const v of violations) {
    if (!grouped.has(v.label)) grouped.set(v.label, []);
    grouped.get(v.label).push(v);
  }
  for (const [label, items] of grouped) {
    console.error(`【${label}】${items[0].hint}`);
    for (const v of items.slice(0, 12)) {
      console.error(`  ${v.rel}:${v.line}  ${v.text}`);
    }
    if (items.length > 12) console.error(`  … 其余 ${items.length - 12} 处`);
    console.error("");
  }
  process.exit(1);
}

console.log("✅ 前端界面契约通过（DESIGN.md 禁止项、行业术语、结构不变量）。");
if (waived) {
  console.log(
    `ℹ 存量豁免 ${waived} 处旧行业术语（P4 清理，见 LEGACY_ALLOW 台账）。新文件出现同类问题会失败。`,
  );
}
