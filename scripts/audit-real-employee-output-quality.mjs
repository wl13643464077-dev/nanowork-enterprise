#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { buildEmployeeOutputQualityAudit, collectApprovedOutputRecords, renderEmployeeOutputQualityAuditMarkdown, sourceHash } from './lib/employee-output-quality-audit.mjs';

function usage() {
  return `真实数字员工产出质量审计（只读，不调用外部API）

用法：node scripts/audit-real-employee-output-quality.mjs [选项]

  --matrix FILE                  真实员工矩阵JSON
  --db FILE                      矩阵对应的SQLite测试库
  --json FILE                    脱敏JSON报告路径
  --markdown FILE                Markdown汇总路径
  --min-restaurant-chars N       餐饮员工正文最小字符数（默认500）
  --min-content-chars N          内容员工正文最小字符数（默认400）
  --allow-partial                允许矩阵未到70/70时仅审计已通过产物
  --help                         显示帮助

默认输入：artifacts/real-employee-matrix-l5-full-v2.json
默认输出：artifacts/real-employee-output-quality-audit.{json,md}
`;
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000) throw new Error(`${option}必须是1-1000000的整数`);
  return parsed;
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`未知参数：${item}`);
    if (['--help', '--allow-partial'].includes(item)) { flags.add(item); continue; }
    const [key, inline] = item.split('=', 2);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key}缺少参数值`);
    values[key] = value;
  }
  const allowed = new Set(['--matrix', '--db', '--json', '--markdown', '--min-restaurant-chars', '--min-content-chars']);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
  return {
    help: flags.has('--help'), allowPartial: flags.has('--allow-partial'),
    matrixPath: path.resolve(values['--matrix'] || 'artifacts/real-employee-matrix-l5-full-v2.json'),
    databasePath: path.resolve(values['--db'] || 'server/data/nanowork-l5-realtest-2026-07-31.db'),
    jsonPath: path.resolve(values['--json'] || 'artifacts/real-employee-output-quality-audit.json'),
    markdownPath: path.resolve(values['--markdown'] || 'artifacts/real-employee-output-quality-audit.md'),
    minimumBodyChars: { restaurant: values['--min-restaurant-chars'] ? parsePositiveInteger(values['--min-restaurant-chars'], '--min-restaurant-chars') : 500, content: values['--min-content-chars'] ? parsePositiveInteger(values['--min-content-chars'], '--min-content-chars') : 400 },
  };
}

function atomicWrite(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

let options;
try { options = parseArgs(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n\n${usage()}`); process.exit(2); }
if (options.help) { process.stdout.write(usage()); process.exit(0); }
for (const [label, filename] of [['--matrix', options.matrixPath], ['--db', options.databasePath]]) {
  if (!fs.existsSync(filename)) { process.stderr.write(`${label}文件不存在：${filename}\n`); process.exit(2); }
}

let database;
try {
  const rawMatrix = fs.readFileSync(options.matrixPath, 'utf8');
  const matrix = JSON.parse(rawMatrix);
  Object.defineProperty(matrix, '__sourceHash', { value: sourceHash(rawMatrix), enumerable: false });
  database = new DatabaseSync(options.databasePath, { readOnly: true });
  database.exec('PRAGMA query_only = ON');
  const records = collectApprovedOutputRecords(matrix, database);
  const report = buildEmployeeOutputQualityAudit({ matrix, records, matrixFile: options.matrixPath, databaseFile: options.databasePath, minimumBodyChars: options.minimumBodyChars });
  atomicWrite(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(options.markdownPath, `${renderEmployeeOutputQualityAuditMarkdown(report)}\n`);
  process.stdout.write([
    `EMPLOYEE_OUTPUT_QUALITY_AUDIT ${report.summary.overallStatus}`,
    `capability=${report.coverage.matrixPassed}/${report.coverage.expectedEmployees} audited=${report.coverage.auditedCapabilityOutputs} quality=${report.summary.capabilityPassed}/${report.coverage.auditedCapabilityOutputs}`,
    `restaurant qaCapabilityRunnable=${report.coverage.restaurantQaCapabilityRunnable}/60 operationalReady=${report.coverage.restaurantOperationalReady}/60 operationalBlocked=${report.coverage.restaurantOperationalBlocked}/60`,
    `businessProduction=${report.summary.businessProductionPassed}/${report.coverage.auditedCapabilityOutputs}`,
    `json=${options.jsonPath}`,
    `markdown=${options.markdownPath}`,
    '',
  ].join('\n'));
  process.exitCode = report.summary.qualityFailed === 0 && (options.allowPartial || report.coverage.matrixComplete) ? 0 : 1;
} catch (error) {
  process.stderr.write(`质量审计失败：${error.message}\n`);
  process.exitCode = 2;
} finally { database?.close(); }
