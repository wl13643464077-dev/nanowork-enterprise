import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanReportBody, splitReportBody } from '../../shared/report-body.mjs';

const archive = '{"schema_version":"1.0","record_type":"nanowork_inspection","status":"draft_for_qa"}';

test('只剥离系统归档块，长报告、末尾建议和正常Mermaid逐字保留', () => {
  const report = '# 会员运营方案\n\n' + '完整经营记录必须保留。'.repeat(900)
    + '\n\n```mermaid\nflowchart LR\n A[顾客] --> B[会员]\n```\n\n## 下一步\n1. 周五复盘。';
  const raw = report + '\n\n```nanowork-inspection JSON\n' + archive + '\n```\n';
  const result = splitReportBody(raw);
  assert.equal(result.body, report);
  assert.equal(result.internalBlocks.length, 1);
  assert.equal(result.internalBlocks[0].complete, true);
  assert.ok(raw.endsWith('```\n'), '清理不修改输入原文');
});

test('JSON围栏仅按已知归档record_type识别，业务JSON/代码/无归档换行保持不变', () => {
  for (const value of ['{"schema_version":"1.0","record_type":"customer","count":3}', '[{"record_type":"customer"}]']) {
    const report = '# 业务数据\n\n```json\n' + value + '\n```\n';
    assert.equal(cleanReportBody(report), report);
  }
  assert.equal(cleanReportBody('业务正文\n\n'), '业务正文\n\n');
  assert.equal(cleanReportBody('业务正文\n\n```json\n' + archive + '\n```'), '业务正文');
  assert.equal(cleanReportBody(archive), '');
});

test('归档围栏支持JSON后缀、大小写、不同长度和tilde，截断归档也不进入正文', () => {
  for (const marker of ['```', '````', '~~~']) {
    const result = splitReportBody('正文\n\n' + marker + 'NANOWORK-INSPECTION JSON\n{bad json}\n' + marker + '\n结尾建议');
    assert.equal(result.body, '正文\n\n结尾建议');
    assert.equal(result.internalBlocks.length, 1);
  }
  const partial = splitReportBody('完整正文\n\n```nanowork-inspection JSON\n{"schema_version":');
  assert.equal(partial.body, '完整正文');
  assert.equal(partial.internalBlocks[0].complete, false);
});

test('普通示例围栏内的嵌套归档字样不被误识别，多个归档之间业务段落不丢失', () => {
  const example = '````markdown\n```nanowork-inspection\n示例\n```\n````\n';
  assert.equal(cleanReportBody(example), example);
  const block = '```nanowork-inspection\n' + archive + '\n```\n';
  const result = splitReportBody('开始\n' + block + '中间\n' + block + '结束');
  assert.equal(result.body, '开始\n中间\n结束');
  assert.equal(result.internalBlocks.length, 2);
});

test('超级店长物料机读块从报告正文剥离，业务图片说明仍保留', () => {
  const report = '# 周末家庭套餐\n\n主KV海报已生成，可下载使用。';
  const raw = `${report}\n\n\`\`\`nanowork-campaign-materials\n{"record_type":"nanowork-campaign-materials","items":[]}\n\`\`\`\n`;
  const result = splitReportBody(raw);
  assert.equal(result.body, report);
  assert.equal(result.internalBlocks.length, 1);
  assert.equal(cleanReportBody(raw).includes('nanowork-campaign-materials'), false);
});
