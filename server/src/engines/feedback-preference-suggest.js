// PRD v2.2 FR-7.3 反馈学习：老板在“采纳/不采纳”里写的一句原因，连续 2 次出现同类
// （如“太长”“不要英文”），就提示“要不要存为默认设置？”。只提示，由老板确认后才写入
// “我的版本”的固定要求；不自动生效。纯函数，无 I/O。

export const FEEDBACK_REASON_RULES = Object.freeze([
  { key: "too_long", label: "太长", pattern: /太长|太啰嗦|啰嗦|简短|精简|短一点|简洁|废话/u, preference: "控制篇幅：先给结论，正文尽量一屏内看完" },
  { key: "too_short", label: "太简单", pattern: /太短|太简单|不够详细|展开|太粗|不够深/u, preference: "关键结论要展开依据和具体做法，不要只给提纲" },
  { key: "no_english", label: "不要英文", pattern: /英文|英语|中英|全中文/u, preference: "全文用中文，专业词不夹英文缩写" },
  { key: "table", label: "要表格", pattern: /表格|列表|做成表|对比表/u, preference: "能用表格的地方优先用表格" },
  { key: "plain", label: "太书面", pattern: /口语|大白话|看不懂|太专业|术语/u, preference: "用老板能直接看懂的大白话，术语第一次出现时解释" },
  { key: "actionable", label: "不落地", pattern: /落地|不能执行|太虚|太空|空泛|具体点|没法用/u, preference: "每条建议写清谁来做、什么时候、怎么验收" },
  { key: "numbers", label: "缺数字", pattern: /没数据|缺数据|要数字|没有数字|量化/u, preference: "结论尽量带数字；没有数据时写明缺什么、怎么补" },
]);

export function feedbackReasonKeys(note) {
  const text = String(note || "");
  if (!text.trim()) return [];
  return FEEDBACK_REASON_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.key);
}

/**
 * notes：最近的反馈原因（新→旧，含本次）。连续两次（本次 + 上一次）出现同类原因即提示。
 * savedPrefs：已保存的固定要求，已保存的不再提示。
 */
export function suggestPreferenceFromFeedback(notes = [], { savedPrefs = [] } = {}) {
  const list = (Array.isArray(notes) ? notes : []).slice(0, 2);
  if (list.length < 2) return null;
  const [current, previous] = list.map(feedbackReasonKeys);
  const shared = current.find((key) => previous.includes(key));
  if (!shared) return null;
  const rule = FEEDBACK_REASON_RULES.find((item) => item.key === shared);
  if (!rule || (Array.isArray(savedPrefs) && savedPrefs.includes(rule.preference))) return null;
  return {
    key: rule.key,
    label: rule.label,
    preference: rule.preference,
    message: `最近两次你都提到“${rule.label}”，要不要存为默认设置？以后派活会自动带上：${rule.preference}`,
  };
}
