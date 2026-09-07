import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const component = fs.readFileSync(
  new URL("../../web/src/components/NativeEmployeeChat.tsx", import.meta.url),
  "utf8",
);
const styles = fs.readFileSync(
  new URL("../../web/src/components/NativeEmployeeChat.css", import.meta.url),
  "utf8",
);

test("AI带货员和小红书种草员的新对话直接展示一句话使用我", () => {
  assert.match(
    component,
    /<section className="native-employee-chat__examples" aria-label="使用示例">\s*<h4>一句话使用我<\/h4>/u,
  );
  assert.match(
    component,
    /10:\s*\[[\s\S]*?15秒视频[\s\S]*?11:\s*\[[\s\S]*?6图种草/u,
  );
});

test("已有聊天记录时示例默认收起但入口常驻", () => {
  assert.match(
    component,
    /!loading\s*&&\s*\(!session\?\.messages\.length\s*\?\s*\([\s\S]*?<details className="native-employee-chat__examples-disclosure">\s*<summary>一句话使用我<\/summary>/u,
  );
  assert.doesNotMatch(component, /<details[^>]+(?:open|defaultOpen)=/u);
  assert.match(styles, /\.native-employee-chat__examples-disclosure\s*\{/u);
});

test("示例按钮保留权限禁用，只预填草稿和选项", () => {
  const start = component.indexOf("const usageExampleContent =");
  const end = component.indexOf("return (", start);
  assert.ok(start >= 0 && end > start, "应能定位示例交互片段");
  const interaction = component.slice(start, end);
  assert.match(interaction, /disabled=\{blocked\}/u);
  assert.match(interaction, /setText\(example\.text\)/u);
  assert.match(
    interaction,
    /setOptions\(current => \(\{ \.\.\.current, \.\.\.example\.options \}\)\)/u,
  );
  assert.doesNotMatch(interaction, /\bsend\s*\(/u);
  assert.doesNotMatch(interaction, /api\.(?:post|put|delete)\s*\(/u);
});
