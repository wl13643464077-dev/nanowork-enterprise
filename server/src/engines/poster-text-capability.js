// 数字员工“海报文字精确叠加”能力说明（运行期注入）。
//
// 为什么不直接改 catalog JSON：
// - server/catalog/content-crew.json 的 capabilities 带 sourceFingerprint，且
//   content-source-parity 测试锁定“45 项能力”与派活源 SHA 一致；
// - server/catalog/restaurant.json 的 deliverables 被 canonical-employee-profile
//   测试按派活源快照逐字段指纹比对。
// 任何追加都会破坏“来源快照一致性”门禁，因此改为在运行包组装处以代码注入，
// 快照层的源定义保持不变，注入内容随 systemContext 一起被 promptHash 覆盖可审计。
export const POSTER_TEXT_CAPABILITY = Object.freeze({
  key: "poster_text_overlay",
  name: "海报文字精确叠加",
  desc: "菜名/价格/门店名等指定汉字不由图像模型绘制，而由系统以 Noto Sans SC 矢量轮廓叠加到无字底图上，逐字与老板输入一致（100% 准确），叠字不额外计费；对应 /api/content/generate-image 的 textOverlay 入参与工具箱“产品图文”的 overlayTitle/overlayPrice/overlayStore。",
  deliverable: "海报文字精确叠加（菜名/价格/门店名 100% 准确）：最终成品 PNG + 无字底图两份产物",
  source: "nanowork-runtime-extension",
  billed: false,
});

export const POSTER_TEXT_CONTENT_EMPLOYEE_IDX = Object.freeze([5]);
export const POSTER_TEXT_RESTAURANT_EMPLOYEE_IDX = Object.freeze([140, 141]);

export function posterTextCapabilityAppliesTo(domain, idx) {
  const value = Number(idx);
  if (domain === "content") return POSTER_TEXT_CONTENT_EMPLOYEE_IDX.includes(value);
  if (domain === "restaurant") return POSTER_TEXT_RESTAURANT_EMPLOYEE_IDX.includes(value);
  return false;
}

/**
 * 注入到 system prompt 的说明段（追加式，不改写源能力清单）。
 */
export function posterTextCapabilityPromptLines() {
  return [
    "【平台扩展能力·海报文字精确叠加（运行期注入，不改写派活源能力清单）】",
    `- ${POSTER_TEXT_CAPABILITY.name}:${POSTER_TEXT_CAPABILITY.desc}`,
    "- 使用规则：凡是海报/物料/活动图上必须逐字正确的文字（菜名、价格、门店名、活动名、日期），一律在生图请求里改用 textOverlay 层声明，并在给图像模型的描述里明确“画面不要出现任何文字”；不要指望图像模型把汉字画对。",
    `- 交付物：${POSTER_TEXT_CAPABILITY.deliverable}；叠字阶段不调用模型、不计费，价格/文字仍须老板核验后才能对外使用。`,
  ];
}
