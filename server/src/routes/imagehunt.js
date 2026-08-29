import { createHash } from "node:crypto";
import { Router } from "express";
import { curTenant, q } from "../db.js";
import { logOp } from "../util.js";
import {
  fetchPublicImageBytes,
  ImageHuntError,
  parsePublicImageUrl,
  searchImageHunt,
} from "../engines/imagehunt.js";
import { saveUploadedFile } from "../engines/filehub.js";

function text(value, max) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function routeError(res, error) {
  const status = Number(error?.status);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error?.message || "图片工具执行失败",
    code: error?.code || "IMAGEHUNT_FAILED",
  });
}

export function createImageHuntRouter({
  searchFn = searchImageHunt,
  fetchImageFn = fetchPublicImageBytes,
  saveFileFn = saveUploadedFile,
} = {}) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const result = await searchFn(req.query.q, {
        limit: req.query.limit,
        signal: req.requestSignal || null,
      });
      res.json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.get("/thumb", async (req, res) => {
    try {
      const delivered = await fetchImageFn(req.query.url, {
        maxBytes: 5 * 1024 * 1024,
        signal: req.requestSignal || null,
      });
      res.setHeader("Content-Type", delivered.mimeType);
      res.setHeader("Content-Length", String(delivered.byteSize));
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(delivered.buffer);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/import", async (req, res) => {
    try {
      const imageUrl = parsePublicImageUrl(req.body?.imageUrl).href;
      const sourceUrl = req.body?.sourceUrl
        ? parsePublicImageUrl(req.body.sourceUrl).href
        : null;
      const title = text(req.body?.title, 160) || "图片搜索导入素材";
      const license = text(req.body?.license, 200);
      const attribution = text(req.body?.attribution, 300);
      if (req.body?.rightsConfirmed !== true || !license) {
        throw new ImageHuntError(
          "导入商用素材前必须确认版权/授权类型并保留来源",
          409,
          "IMAGEHUNT_RIGHTS_NOT_CONFIRMED",
        );
      }
      const delivered = await fetchImageFn(imageUrl, {
        maxBytes: 8 * 1024 * 1024,
        signal: req.requestSignal || null,
      });
      const hash = createHash("sha256").update(delivered.buffer).digest("hex");
      const existing = q.get(
        `SELECT id FROM materials
        WHERE tenant_id=? AND source_type='imagehunt' AND snapshot_hash=?
        ORDER BY id DESC LIMIT 1`,
        curTenant(),
        hash,
      );
      if (existing) {
        return res.json({
          ok: true,
          materialId: Number(existing.id),
          alreadyImported: true,
          billing: { state: "not_applicable", credits: 0 },
        });
      }
      const extension = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
      }[delivered.mimeType];
      if (!extension) {
        throw new ImageHuntError(
          "下载结果不是允许入库的图片格式",
          415,
          "IMAGEHUNT_MIME_INVALID",
        );
      }
      const storedFile = saveFileFn({
        name: `imagehunt-${hash.slice(0, 16)}.${extension}`,
        b64: delivered.buffer.toString("base64"),
        mime: delivered.mimeType,
        purpose: "imagehunt",
        userId: req.user.id,
      });
      const localFileUrl = text(storedFile?.row?.file_url, 1000);
      if (!localFileUrl?.startsWith("/uploads/files/")) {
        throw new ImageHuntError(
          "图片素材没有形成租户本地文件",
          500,
          "IMAGEHUNT_FILE_PERSIST_FAILED",
        );
      }
      const bodySnapshot = [
        "已固化的图片素材",
        `mime=${delivered.mimeType}`,
        `bytes=${delivered.byteSize}`,
        `sha256=${hash}`,
        `file=${localFileUrl}`,
      ].join("\n");
      const artifactSnapshot = {
        schemaVersion: "nanowork.imagehunt-material/1",
        provider: text(req.body?.provider, 40) || "imagehunt",
        originalImageUrl: delivered.finalUrl || imageUrl,
        sourceUrl,
        fileId: Number(storedFile.row.id) || null,
        fileUrl: localFileUrl,
        mimeType: delivered.mimeType,
        byteSize: delivered.byteSize,
        contentSha256: hash,
        rights: {
          confirmed: true,
          commercialUse: true,
          license,
          attribution: attribution || null,
          confirmedBy: Number(req.user.id),
          confirmedAt: new Date().toISOString(),
        },
        externalAction: "download_public_image",
      };
      const inserted = q.run(
        `INSERT INTO materials(
          tenant_id,name,type,tags,url,source_type,source_id,creator_id,note,
          body_snapshot,artifact_snapshot_json,snapshot_hash
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        curTenant(),
        title,
        "图片",
        JSON.stringify(["图片搜索", "版权已确认"]),
        localFileUrl,
        "imagehunt",
        null,
        req.user.id,
        `授权：${license}${attribution ? `；署名：${attribution}` : ""}`,
        bodySnapshot,
        JSON.stringify(artifactSnapshot),
        hash,
      );
      const materialId = Number(inserted.lastInsertRowid);
      logOp(
        req.user,
        "内容生产仓",
        "导入图片搜索素材",
        `${title} #${materialId}`,
      );
      res.status(201).json({
        ok: true,
        materialId,
        alreadyImported: false,
        artifact: artifactSnapshot,
        billing: { state: "not_applicable", credits: 0 },
      });
    } catch (error) {
      routeError(res, error);
    }
  });

  return router;
}

export default createImageHuntRouter();
