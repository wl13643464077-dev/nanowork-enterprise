/**
 * 按派活 build_delivery 组装内容流水线终态：
 * 定稿 + 各平台发布包（文案版本 + 该平台封面/配图 + 后台直达）。
 */
import { isXhsPipelineDraft, selectedXhsPipelineVersion } from './content-xhs-pipeline.js';
import { xhsVersionsForDisplay } from './content-xhs-output.js';

const CONTENT_PLATFORM_DELIVERY_SPECS = Object.freeze({
  小红书: Object.freeze({
    emoji: "📕",
    upload_url: "https://creator.xiaohongshu.com/publish/publish",
  }),
  公众号: Object.freeze({
    emoji: "💬",
    upload_url: "https://mp.weixin.qq.com/",
  }),
  微信公众号: Object.freeze({
    emoji: "💬",
    upload_url: "https://mp.weixin.qq.com/",
  }),
  抖音: Object.freeze({
    emoji: "🎵",
    upload_url: "https://creator.douyin.com/creator-micro/content/upload",
  }),
  视频号: Object.freeze({
    emoji: "📹",
    upload_url: "https://channels.weixin.qq.com/platform/post/create",
  }),
  B站: Object.freeze({
    emoji: "📺",
    upload_url: "https://member.bilibili.com/platform/upload/video/frame",
  }),
  微博: Object.freeze({
    emoji: "🐘",
    upload_url: "https://weibo.com/",
  }),
});

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function outputAt(stationOutputs, idx) {
  const value = stationOutputs?.[idx] ?? stationOutputs?.[String(idx)];
  return plainObject(value) ? value : {};
}

export function canonicalContentPlatformName(value) {
  const text = firstString(value);
  if (text === "微信公众号") return "公众号";
  return text;
}

function specForPlatform(platform) {
  const name = canonicalContentPlatformName(platform);
  return (
    CONTENT_PLATFORM_DELIVERY_SPECS[platform]
    || CONTENT_PLATFORM_DELIVERY_SPECS[name]
    || { emoji: "📄", upload_url: "" }
  );
}

function samePlatform(left, right) {
  return canonicalContentPlatformName(left) === canonicalContentPlatformName(right);
}

export function assembleContentPipelineDelivery(stationOutputs = {}) {
  const draft = outputAt(stationOutputs, 3);
  const style = outputAt(stationOutputs, 4);
  const media = outputAt(stationOutputs, 5);
  const cover = outputAt(stationOutputs, 6);
  const publish = outputAt(stationOutputs, 8);
  const retro = outputAt(stationOutputs, 9);
  const xhsDraft = isXhsPipelineDraft(draft);
  const xhs = selectedXhsPipelineVersion(stationOutputs, { required: false });
  const titleCandidates = xhs ? [xhs.version.title] : xhsDraft ? [] : Array.isArray(style.title_candidates) && style.title_candidates.length
    ? style.title_candidates
    : Array.isArray(draft.title_candidates)
      ? draft.title_candidates
      : [];
  const body = xhs ? xhs.version.body : xhsDraft ? '' : firstString(style.body) || firstString(draft.body);
  const tags = xhs ? xhs.version.tags : Array.isArray(draft.tags) ? draft.tags : [];
  const images = Array.isArray(media.images) ? media.images : [];
  const covers = Array.isArray(cover.covers) ? cover.covers : [];
  const versions = xhsDraft && !xhs ? [] : Array.isArray(publish.versions) ? publish.versions : [];
  const fallbackCover = covers[0] || null;
  const packs = versions.map((version) => {
    const platform = firstString(version?.platform);
    const spec = specForPlatform(platform);
    const packCover = covers.find((item) => samePlatform(item?.platform, platform)) || fallbackCover;
    const packImages = images.filter((item) => {
      const imagePlatform = firstString(item?.platform);
      return !imagePlatform
        || imagePlatform === "通用"
        || samePlatform(imagePlatform, platform);
    });
    return {
      ...version,
      ...(xhs && platform === '小红书' ? {
        title: xhs.version.title, body: xhs.version.body, tags: xhs.version.tags,
        cover_text: xhs.version.cover_text, comment_prompt: xhs.version.comment_prompt,
        strategy: xhs.version.strategy, source_version_id: xhs.sourceVersionId, version_id: xhs.versionId,
      } : {}),
      emoji: spec.emoji,
      upload_url: spec.upload_url,
      cover: packCover,
      images: packImages,
    };
  });
  return Object.freeze({
    schemaVersion: "nanowork.content-pipeline-delivery/1",
    title: firstString(titleCandidates[0]),
    title_candidates: titleCandidates,
    body,
    tags,
    images,
    covers,
    versions,
    packs,
    publish_plan: firstString(publish.publish_plan),
    retro,
    ...(xhsDraft ? { xhsVersions: xhsVersionsForDisplay(draft), xhsImagePlan: draft.image_plan,
      xhsSelection: xhs?.selection || null, xhsSelectionRequired: !xhs, xhsFinalVersion: xhs ? { ...xhs.version, versionId: xhs.versionId } : null } : {}),
  });
}

export function renderContentPipelineDeliveryMarkdown(delivery) {
  if (!plainObject(delivery)) return "";
  const packs = Array.isArray(delivery.packs) ? delivery.packs : [];
  const sections = [
    "# 内容流水线发布包",
    "",
    delivery.title ? `**定稿标题**：${delivery.title}` : "",
    delivery.publish_plan ? `**发布节奏**：${delivery.publish_plan}` : "",
    "",
  ].filter((item, index, list) => item !== "" || list[index - 1] !== "");
  for (const pack of packs) {
    const tags = Array.isArray(pack.tags)
      ? pack.tags.map((tag) => `#${String(tag).trim()}`).join(" ")
      : "";
    const checklist = Array.isArray(pack.checklist)
      ? pack.checklist.map((item) => `- ${String(item).trim()}`).join("\n")
      : "";
    sections.push(
      `## ${pack.emoji || "📄"} ${firstString(pack.platform) || "平台"}发布包`,
      "",
      `**标题**：${firstString(pack.title)}`,
      pack.cover_text ? `**封面文案**：${firstString(pack.cover_text)}` : '',
      pack.source_version_id ? `**所选源版本**：${firstString(pack.source_version_id)}（${firstString(pack.strategy)}）` : '',
      `**建议发布时间**：${firstString(pack.best_time)}`,
      tags ? `**标签**：${tags}` : "",
      pack.upload_url ? `**发布后台**：${pack.upload_url}` : "",
      firstString(pack.note) ? `**注意事项**：${firstString(pack.note)}` : "",
      "",
      "### 适配正文",
      "",
      firstString(pack.body),
      pack.comment_prompt ? `\n**首评**：${firstString(pack.comment_prompt)}` : '',
      "",
      checklist ? "### 后台操作清单\n" : "",
      checklist,
      "",
    );
  }
  if (plainObject(delivery.retro) && firstString(delivery.retro.report)) {
    sections.push("## 复盘报告", "", firstString(delivery.retro.report), "");
  }
  return sections.filter((item, index, list) => item !== "" || list[index - 1] !== "").join("\n").trim();
}
