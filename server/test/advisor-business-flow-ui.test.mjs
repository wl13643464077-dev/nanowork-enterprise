import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('已有会诊消息可用同一 advisor_message id 打开只读业务流', () => {
  const advisor = read('web/src/pages/Advisor.tsx');
  const trace = read('web/src/components/BusinessFlowTrace.tsx');

  assert.match(advisor, /import BusinessFlowTrace from ['"]\.\.\/components\/BusinessFlowTrace['"]/u);
  assert.match(
    advisor,
    /const \[businessFlowMessageId, setBusinessFlowMessageId\] = useState<number \| null>\(null\)/u,
  );
  assert.match(
    advisor,
    /aria-label=['"]只读查看业务流['"][\s\S]{0,400}onClick=\{\(\) => setBusinessFlowMessageId\(m\.serverId\)\}[\s\S]{0,200}查看业务流/u,
  );
  assert.match(
    advisor,
    /<BusinessFlowTrace\s+sourceType=['"]advisor_message['"]\s+sourceId=\{businessFlowMessageId\}\s+open=\{businessFlowMessageId !== null\}\s+onClose=\{\(\) => setBusinessFlowMessageId\(null\)\}/u,
  );

  assert.match(trace, /api\s*\.get\(`\/business-flow\/\$\{sourceType\}\/\$\{currentId\}`/u);
  assert.doesNotMatch(trace, /api\s*\.(?:post|put|patch|delete)\([^\n]*business-flow/u);
  assert.match(trace, /当前角色不能查看业务流/u);
});
