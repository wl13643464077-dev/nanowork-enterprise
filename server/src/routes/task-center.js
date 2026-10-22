import { Router } from "express";
import {
  getUnifiedTaskDetail,
  listUnifiedTasks,
  taskCenterPublicErrorResponse,
  recordUnifiedTaskFeedback,
} from "../engines/task-center.js";
import { getReportRefineState, refineReport } from "../engines/report-refine.js";
import { aiFailurePayload } from "../engines/ai-delivery-status.js";

const router = Router();

// ===== 报告多轮优化（餐饮数字员工任务）=====
// 老板针对已交付的这份报告继续提修改意见，每轮生成一个独立版本；
// 原稿与采纳状态不变。真实计费、fail-closed。
router.get("/restaurant/:id/refine", (req, res) => {
  try {
    res.set("Cache-Control", "private, no-store");
    res.json(getReportRefineState(req.user, req.params.id));
  } catch (error) {
    res.status(Number(error.status) || 500).json({
      error: String(error?.message || "读取报告优化状态失败").slice(0, 200),
      requestId: req.requestId,
    });
  }
});

router.post("/restaurant/:id/refine", async (req, res) => {
  try {
    const result = await refineReport(req.user, req.params.id, req.body || {}, {
      signal: req.requestSignal,
    });
    res.set("Cache-Control", "private, no-store");
    res.json(result);
  } catch (error) {
    res.status(Number(error.status) || 502).json(
      aiFailurePayload(error, { requestId: req.requestId }),
    );
  }
});

router.get("/", (req, res) => {
  res.json(listUnifiedTasks(req.user, req.query));
});

router.get("/:kind/:id", (req, res, next) => {
  try {
    res.json(getUnifiedTaskDetail(req.user, req.params.kind, req.params.id));
  } catch (error) {
    const body = taskCenterPublicErrorResponse(error);
    if (!body) return next(error);
    return res.status(Number(error.status)).json({
      ...body,
      requestId: req.requestId,
    });
  }
});

router.post("/:kind/:id/feedback", (req, res, next) => {
  try {
    res.json(
      recordUnifiedTaskFeedback(
        req.user,
        req.params.kind,
        req.params.id,
        req.body,
      ),
    );
  } catch (error) {
    const body = taskCenterPublicErrorResponse(error);
    if (!body) return next(error);
    return res
      .status(Number(error.status))
      .json({ ...body, requestId: req.requestId });
  }
});

export default router;
