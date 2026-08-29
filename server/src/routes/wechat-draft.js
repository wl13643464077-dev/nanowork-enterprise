import { Router } from "express";

import {
  listWechatDraftSources,
  listWechatDraftThemes,
  publicWechatConfig,
  saveWechatConfig,
  WechatProviderError,
  wechatDraftService,
} from "../engines/wechat-draft.js";
import { logOp } from "../util.js";

function sendError(res, error) {
  const requested = Number(error?.status);
  const status =
    Number.isInteger(requested) && requested >= 400 && requested < 600
      ? requested
      : 500;
  const safe =
    error instanceof WechatProviderError || status < 500
      ? String(error?.message || "公众号草稿请求失败").slice(0, 500)
      : "公众号草稿服务处理失败，请稍后重试";
  res.status(status).json({
    error: safe,
    code: String(error?.code || "WECHAT_DRAFT_FAILED").slice(0, 80),
    ...((error?.supersededBy || error?.deliveryState?.supersededBy)
      ? {
          supersededBy:
            error.supersededBy || error.deliveryState.supersededBy,
        }
      : {}),
  });
}

export function createWechatDraftRouter({ service = wechatDraftService } = {}) {
  const router = Router();

  router.get("/themes", (_req, res) => {
    res.json(listWechatDraftThemes());
  });

  router.get("/config", (req, res) => {
    try {
      res.json({ config: publicWechatConfig(req.user.tenant_id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put("/config", (req, res) => {
    try {
      const config = saveWechatConfig({
        tenantId: req.user.tenant_id,
        appId: req.body?.appId,
        appSecret: req.body?.appSecret,
      });
      logOp(
        req.user,
        "内容生产仓",
        "更新公众号官方 API 配置",
        "凭据已保密保存",
      );
      res.json({ config });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/config/test", async (req, res) => {
    try {
      const result = await service.testConnection(req.user);
      res.json({ ...result, message: "微信官方 API 连接成功，可以投递草稿箱" });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/sources", (req, res) => {
    try {
      res.json({
        sources: listWechatDraftSources({
          tenantId: req.user.tenant_id,
          limit: req.query.limit,
        }),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/deliveries", (req, res) => {
    try {
      res.json({ deliveries: service.listDeliveries(req.user, req.query) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/deliveries", async (req, res) => {
    try {
      const result = await service.createDelivery({
        user: req.user,
        sourceType: req.body?.sourceType,
        sourceId: req.body?.sourceId,
        coverFileId: req.body?.coverFileId,
        imageFileIds: req.body?.imageFileIds,
        author: req.body?.author,
        theme: req.body?.theme,
      });
      logOp(
        req.user,
        "内容生产仓",
        result.created ? "显式发起公众号草稿投递" : "命中公众号草稿幂等记录",
        `wechat#${result.delivery.id} / ${result.delivery.sourceType}#${result.delivery.sourceId}`,
      );
      res.status(result.created ? 202 : 200).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/deliveries/:id", (req, res) => {
    try {
      res.json({ delivery: service.getDelivery(req.user, req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/deliveries/:id/reconcile", async (req, res) => {
    try {
      const delivery = await service.reconcile(req.user, req.params.id);
      logOp(
        req.user,
        "内容生产仓",
        "核对公众号草稿隐藏标记",
        `wechat#${delivery.id}`,
      );
      res.json({ delivery });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/deliveries/:id/confirm-not-delivered", async (req, res) => {
    try {
      const delivery = await service.confirmNotDelivered(
        req.user,
        req.params.id,
        {
          confirmedNoDraft: req.body?.confirmedNoDraft,
          titleConfirmation: req.body?.titleConfirmation,
        },
      );
      logOp(
        req.user,
        "内容生产仓",
        "人工确认公众号草稿未送达",
        `wechat#${delivery.id}`,
      );
      res.json({ delivery });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

export default createWechatDraftRouter();
