import { Router } from "express";
import {
  getUnifiedTaskDetail,
  listUnifiedTasks,
  taskCenterPublicErrorResponse,
  recordUnifiedTaskFeedback,
} from "../engines/task-center.js";

const router = Router();

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
