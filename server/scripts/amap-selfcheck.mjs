#!/usr/bin/env node
// 高德三步自检（PRD v2.2 FR-4.3）。用法：在 server 目录执行
//   node scripts/amap-selfcheck.mjs
// 读取 .env 中的 AMAP_WEB_KEY，依次跑 地理编码→周边搜索→关键字搜索，
// 打印每步的成功与否、耗时、返回条数、带人均的条数和错误码说明。不会打印 Key。
import "../src/env.js";
import { runAmapSelfCheck } from "../src/engines/amap.js";

const result = await runAmapSelfCheck();
if (!result.configured) {
  console.log(`✗ ${result.error}`);
  process.exit(2);
}
for (const step of result.steps) {
  console.log(
    `${step.ok ? "✓" : "✗"} ${step.name}  ${step.ms}ms  返回${step.returned}条` +
      (step.withCost == null ? "" : `  带人均${step.withCost}条`) +
      (step.infocode ? `  infocode ${step.infocode}` : "") +
      (step.explanation ? `  ${step.explanation}` : ""),
  );
}
console.log(`当日调用 ${result.usage.count}/${result.usage.quota}（${result.usage.qps} QPS）`);
console.log(result.ok ? "自检通过" : "自检未通过：按上面的 infocode 到高德控制台检查 Key 类型、白名单和当日配额");
process.exit(result.ok ? 0 : 1);
