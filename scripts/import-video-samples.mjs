#!/usr/bin/env node
// 批量导入平台级视频/图片样片（招商会前把线下生成好的 5–10 条一次导入）。
//
// 用法：
//   node scripts/import-video-samples.mjs <目录> [--tenant 1] [--scope platform|tenant] [--creator <userId>] [--dry-run]
//
// 目录内文件约定：
//   - 支持 .mp4 / .png / .jpg / .jpeg / .webp（与上传白名单一致；视频用 ffprobe 校验时长）
//   - 文件名可带标签：  火锅门头实拍[火锅,门头,菜品特写].mp4
//   - 同名 .json 优先： 火锅门头实拍.json → { "name": "...", "tags": ["火锅","门头"], "note": "销售讲解词" }
//
// 环境：与服务端相同的 NANOWORK_DB（缺省=server/data 默认库）；ffprobe 走 FFPROBE_PATH 或 PATH。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initSchema, migrateV2, q, runWithTenant } from "../server/src/db.js";
import {
  SAMPLE_SOURCE_TYPES,
  insertSampleMaterial,
  parseSampleFileMeta,
  persistSampleFile,
  probeSampleVideo,
  projectSample,
  sampleMimeForExt,
  validateSampleFileStat,
} from "../server/src/engines/content-samples.js";

export const USAGE = `用法：node scripts/import-video-samples.mjs <目录> [--tenant 1] [--scope platform|tenant] [--creator <userId>] [--dry-run]

  <目录>            含 .mp4 / .png / .jpg / .jpeg / .webp 的本地目录（忽略子目录）
  --tenant <id>     写入的租户 ID（缺省 1；--scope tenant 时为样片所属租户）
  --scope <scope>   platform=平台级共享（全租户可见，缺省）；tenant=仅该租户可见
  --creator <id>    记录导入人 userId（可选）
  --dry-run         只校验与解析，不复制文件、不写库
  --help, -h        显示本帮助

文件名约定：  火锅门头实拍[火锅,门头,菜品特写].mp4   （方括号内为标签，可省略）
同名 .json：  火锅门头实拍.json → { "name": "...", "tags": ["火锅","门头"], "note": "销售讲解词" }
环境变量：    NANOWORK_DB（缺省=server/data 默认库）、FFPROBE_PATH（视频时长校验）、NANOWORK_SAMPLE_UPLOAD_ROOT
退出码：      0 全部导入；2 有文件被跳过；1 参数或目录错误`;

export function parseCliArgs(argv) {
  const options = { directory: "", tenantId: 1, scope: "platform", creatorId: null, dryRun: false, help: false };
  const rest = [...argv];
  while (rest.length) {
    const item = rest.shift();
    if (item === "--help" || item === "-h") return { ...options, help: true };
    if (item === "--tenant") options.tenantId = Number(rest.shift());
    else if (item === "--scope") options.scope = String(rest.shift() || "").trim();
    else if (item === "--creator") options.creatorId = Number(rest.shift());
    else if (item === "--dry-run") options.dryRun = true;
    else if (item.startsWith("--")) throw new Error(`未知参数：${item}`);
    else if (!options.directory) options.directory = item;
    else throw new Error(`多余参数：${item}`);
  }
  if (!options.directory) throw new Error("请提供样片目录：node scripts/import-video-samples.mjs <目录>");
  if (!Number.isSafeInteger(options.tenantId) || options.tenantId <= 0) throw new Error("--tenant 必须是正整数");
  if (!["platform", "tenant"].includes(options.scope)) throw new Error("--scope 仅支持 platform / tenant");
  if (options.creatorId !== null && (!Number.isSafeInteger(options.creatorId) || options.creatorId <= 0)) {
    throw new Error("--creator 必须是正整数");
  }
  return options;
}

/**
 * 扫描目录：只收媒体文件，忽略 .json 与子目录；同名 .json 作为 sidecar。
 * 返回按文件名排序的 { filePath, meta, sidecarPath, size } 列表；纯函数（只读文件系统）。
 */
export function collectSampleFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const byName = new Map(entries.filter((entry) => entry.isFile()).map((entry) => [entry.name, entry]));
  const items = [];
  for (const [name] of byName) {
    if (/\.json$/iu.test(name)) continue;
    const filePath = path.join(directory, name);
    const stem = name.replace(/\.[^.]+$/u, "");
    const sidecarName = [...byName.keys()].find((candidate) => candidate.toLowerCase() === `${stem}.json`.toLowerCase())
      || [...byName.keys()].find((candidate) => candidate.toLowerCase() === `${stem.replace(/\s*[\[【][^\]】]*[\]】]\s*$/u, "")}.json`.toLowerCase());
    const sidecarPath = sidecarName ? path.join(directory, sidecarName) : null;
    const sidecarJson = sidecarPath ? fs.readFileSync(sidecarPath, "utf8") : null;
    const meta = parseSampleFileMeta(name, sidecarJson);
    if (!meta.type) continue;
    items.push({ filePath, meta, sidecarPath, size: fs.statSync(filePath).size });
  }
  return items.sort((a, b) => a.meta.fileName.localeCompare(b.meta.fileName, "zh-Hans-CN"));
}

export async function importSampleDirectory(options, { log = console.log } = {}) {
  const directory = path.resolve(options.directory);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`目录不存在：${directory}`);
  }
  const files = collectSampleFiles(directory);
  if (!files.length) {
    log("目录里没有可导入的 mp4/png/jpg/webp 文件。");
    return { imported: [], skipped: [] };
  }
  const imported = [];
  const skipped = [];
  for (const item of files) {
    try {
      validateSampleFileStat({ ext: item.meta.ext, size: item.size });
      const probe = item.meta.type === "video" ? await probeSampleVideo(item.filePath) : null;
      if (options.dryRun) {
        log(`[dry-run] ${item.meta.fileName} → ${item.meta.name} tags=${JSON.stringify(item.meta.tags)} note=${item.meta.note ? "有" : "无"}${probe ? ` 时长=${probe.duration.toFixed(1)}s` : ""}`);
        imported.push({ file: item.meta.fileName, dryRun: true, meta: item.meta, probe });
        continue;
      }
      const stored = persistSampleFile({
        sourcePath: item.filePath,
        scopeDir: options.scope === "platform" ? "platform" : `tenant-${options.tenantId}`,
        name: item.meta.name,
        ext: item.meta.ext,
      });
      const row = runWithTenant(options.tenantId, () =>
        insertSampleMaterial({
          tenantId: options.tenantId,
          scope: options.scope,
          creatorId: options.creatorId,
          name: item.meta.name,
          sampleType: item.meta.type,
          url: stored.url,
          tags: item.meta.tags,
          note: item.meta.note,
          sourceType: SAMPLE_SOURCE_TYPES.script,
          sourceId: null,
          artifact: {
            mimeType: sampleMimeForExt(item.meta.ext),
            size: stored.size,
            sha256: stored.sha256,
            durationSeconds: probe?.duration ?? null,
            width: probe?.width ?? null,
            height: probe?.height ?? null,
            origin: `script:${item.meta.fileName}`,
          },
        }),
      );
      const projected = projectSample(row, { tenantId: options.tenantId });
      imported.push(projected);
      log(`✓ ${item.meta.fileName} → 样片#${projected.id} ${projected.name} [${projected.tags.join(",")}] ${projected.url}`);
    } catch (error) {
      skipped.push({ file: item.meta.fileName, error: error.message });
      log(`✗ ${item.meta.fileName}：${error.message}`);
    }
  }
  return { imported, skipped };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      process.exit(0);
    }
    initSchema();
    migrateV2();
    const result = await importSampleDirectory(options);
    const total = q.get(`SELECT COUNT(*) n FROM materials WHERE is_sample=1 AND sample_scope='platform'`)?.n || 0;
    console.log(`完成：导入 ${result.imported.length}，跳过 ${result.skipped.length}；平台样片总数 ${total}`);
    process.exit(result.skipped.length ? 2 : 0);
  } catch (error) {
    console.error(`导入失败：${error.message}`);
    process.exit(1);
  }
}
