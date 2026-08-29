function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function previewText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function previewFromItems(value, keys = ["title", "topic", "name"]) {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (!plainObject(item)) return "";
      return keys.map((key) => previewText(item[key])).find(Boolean) || "";
    })
    .filter(Boolean)
    .slice(0, 4)
    .join("、");
}

export function contentRunResultPreview(raw, limit = 180) {
  const source = String(raw || "").trim();
  if (!source) return null;
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const candidate = fenced ? fenced[1].trim() : source;
  try {
    const parsed = JSON.parse(candidate);
    if (plainObject(parsed)) {
      const primary = [
        previewText(parsed.summary),
        previewText(parsed.briefing),
        previewText(parsed.report),
        previewText(parsed.publish_plan),
        previewText(parsed.body),
      ].find(Boolean);
      const versions = plainObject(parsed.versions)
        ? Object.entries(parsed.versions)
            .map(([platform, value]) => {
              const version = plainObject(value) ? value : {};
              const title =
                previewText(version.title) ||
                previewText(version.headline) ||
                previewText(version.body).slice(0, 50);
              return title ? `${platform}：${title}` : "";
            })
            .filter(Boolean)
            .slice(0, 3)
            .join("；")
        : previewFromItems(parsed.versions, ["title", "headline", "body"]);
      const cards =
        previewFromItems(parsed.topics) ||
        previewFromItems(parsed.benchmarks) ||
        previewFromItems(parsed.next_topics);
      const readable = [primary, versions, cards].filter(Boolean).join("；");
      if (readable) return readable.replace(/\s+/g, " ").slice(0, limit);
    }
  } catch {
    // 非 JSON 岗位产物保持 Markdown 文本预览，不影响完整结果渲染。
  }
  return source
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/^[{}\[\]"]+|[{}\[\]"]+$/gu, "")
    .replace(/\s+/g, " ")
    .slice(0, limit);
}
