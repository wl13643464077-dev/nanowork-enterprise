#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  auditRestaurantMaterialCoverage,
  restaurantMaterialAuditMarkdown,
} from './lib/restaurant-material-coverage-audit.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv.includes('--help')) {
  console.log(`审计 61 名餐饮数字员工的每一条 requiredInput 是否获得语义匹配的材料正文。

用法：
  node scripts/audit-restaurant-material-coverage.mjs [--format markdown|json] [--out FILE] [--report-only]

默认输出 Markdown；存在任何错配、过泛、缺字段或未覆盖映射时退出码为 1。
--report-only 只用于生成审计文档，不改变报告中的 FAIL 结论。`);
  process.exit(0);
}

const format = String(option('--format') || 'markdown').toLowerCase();
if (!['markdown', 'json'].includes(format)) {
  console.error(`不支持的 --format：${format}`);
  process.exit(2);
}

const report = auditRestaurantMaterialCoverage();
const output = format === 'json'
  ? `${JSON.stringify(report, null, 2)}\n`
  : `${restaurantMaterialAuditMarkdown(report)}\n`;
const outputPath = option('--out');
if (outputPath) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, output, 'utf8');
  console.log(`${report.valid ? 'PASS' : 'FAIL'}: ${report.summary.failingInputCount}/${report.summary.requiredInputCount} 条必需输入未通过；QA能力可跑=${report.summary.qaCapabilityRunnable.passed}/${report.summary.qaCapabilityRunnable.total}；fixture任务就绪=${report.summary.fixtureOperationalReady.passed}/${report.summary.fixtureOperationalReady.total}；隔离生成就绪=${report.summary.operationalReady.passed}/${report.summary.operationalReady.total}；真实业务采纳/外部执行就绪=${report.summary.businessOperationalReady.passed}/${report.summary.businessOperationalReady.total}；真实业务/外部阻断=${report.summary.businessOperationalBlocked.count}/${report.summary.businessOperationalBlocked.total}；报告=${resolved}`);
} else {
  process.stdout.write(output);
}

if (!report.valid && !process.argv.includes('--report-only')) process.exitCode = 1;
