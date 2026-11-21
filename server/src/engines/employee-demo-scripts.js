// PRD v2.2 FR-9：演示 SOP。
// - A1–A8 每位 2 条固定演示话术（取自老板提问题库的 q1/q2），带 {店名}{城市}{商圈}{品类} 占位；
//   演示时只填这 4 个字段，其余槽位用题库示例值兜底，保证一键可派。
// - 每条话术可保存一份“样例结果”：从一次真实完成的任务复制正文，标“样例”和实跑日期，
//   只在现场网络或供应商故障时兜底展示，不冒充实时结果；页面始终保留“现在实跑”。
import { curTenant, q } from "../db.js";
import { loadEmployeeQuestionTemplates, fillQuestionTemplate } from "./employee-question-templates.js";
import { INTENT_LABELS, normalizeIntentType } from "./employee-intent-router.js";
import { readableBody } from "./report-refine.js";

export const DEMO_FIELDS = Object.freeze(["店名", "城市", "商圈", "品类"]);
export const DEMO_DEFAULTS = Object.freeze({ 店名: "罗二火锅", 城市: "北京", 商圈: "望京", 品类: "火锅" });
// A 级 8 位（A7 柏带训/方连锁待老板最终确认；题库当前为柏带训）。
export const DEMO_EMPLOYEE_ORDER = Object.freeze([102, 101, 108, 160, 144, 161, 137, "content-11"]);
const SAMPLE_MAX_CHARS = 60_000;
// 需要客户自有数据或照片才能答好的话术（演示前先导入或现场上传）。
const REQUIRES_DATA_RE = /上传|照片|这份|销量|毛利|复购|\{周期\}/u;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function exampleFor(slotDictionary, key) {
  const examples = slotDictionary?.[key]?.examples;
  return Array.isArray(examples) && examples.length ? String(examples[0]) : null;
}

/** 演示话术目录（纯读取题库）。 */
export function demoScriptCatalog() {
  const data = loadEmployeeQuestionTemplates();
  const items = [];
  DEMO_EMPLOYEE_ORDER.forEach((employee, order) => {
    const rows = data.items
      .filter((item) => String(item.employee) === String(employee) && item.tier === "A")
      .filter((item) => /-q[12]$/u.test(item.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const item of rows) {
      const type = normalizeIntentType(item.type) || "plan";
      items.push({
        id: item.id,
        tierCode: `A${order + 1}`,
        employee,
        employeeIdx: typeof employee === "number" ? employee : null,
        domain: typeof employee === "number" ? "restaurant" : "content",
        person: item.person,
        title: item.title,
        type,
        typeLabel: INTENT_LABELS[type],
        template: item.template,
        slots: (item.slots || []).map((slot) => slot.key),
        youGet: item.you_get || "",
        why: item.why || "",
        requiresData: REQUIRES_DATA_RE.test(item.template),
      });
    }
  });
  return { items, slotDictionary: data.slots || {} };
}

/**
 * 用演示字段（店名/城市/商圈/品类）+ 题库示例值填满话术。返回 { filled, unfilledSlots }。
 */
export function fillDemoScript(script, fields = {}, slotDictionary = {}) {
  const values = {};
  for (const key of DEMO_FIELDS) {
    const value = String(fields?.[key] ?? "").trim().slice(0, 40);
    values[key] = value || DEMO_DEFAULTS[key];
  }
  for (const key of script.slots || []) {
    if (values[key]) continue;
    const example = exampleFor(slotDictionary, key);
    if (example) values[key] = example;
  }
  const filled = fillQuestionTemplate(script.template, values);
  const unfilledSlots = [...filled.matchAll(/\{([^{}]{1,12})\}/gu)].map((match) => match[1]);
  return { filled, unfilledSlots };
}

function sampleRows(tenantId) {
  return q.all(
    "SELECT script_id,employee_idx,task_id,task_title,captured_at FROM employee_demo_samples WHERE tenant_id=?",
    tenantId,
  );
}

/** 演示面板数据：话术 + 填好的问法 + 是否有样例。 */
export function demoScriptsView(fields = {}, tenantId = curTenant()) {
  const { items, slotDictionary } = demoScriptCatalog();
  const samples = new Map(sampleRows(tenantId).map((row) => [row.script_id, row]));
  return {
    fields: DEMO_FIELDS,
    defaults: DEMO_DEFAULTS,
    items: items.map((item) => {
      const sample = samples.get(item.id);
      return {
        ...item,
        ...fillDemoScript(item, fields, slotDictionary),
        sample: sample
          ? { taskId: Number(sample.task_id), capturedAt: sample.captured_at, taskTitle: sample.task_title || "" }
          : null,
      };
    }),
  };
}

export function getDemoSample(scriptId, tenantId = curTenant()) {
  const row = q.get(
    "SELECT script_id,employee_idx,task_id,task_title,body,captured_at FROM employee_demo_samples WHERE tenant_id=? AND script_id=?",
    tenantId,
    String(scriptId || ""),
  );
  if (!row) throw httpError(404, "这条话术还没有样例结果");
  return {
    scriptId: row.script_id,
    taskId: Number(row.task_id),
    taskTitle: row.task_title || "",
    capturedAt: row.captured_at,
    label: `样例 · ${String(row.captured_at || "").slice(0, 10)} 实跑结果（非本次实时生成）`,
    markdown: row.body,
  };
}

/**
 * 把一次真实完成的餐饮任务存为某条话术的样例。只接受本租户、同一员工、已交付的任务。
 */
export function saveDemoSampleFromTask(scriptId, taskId, user, tenantId = curTenant()) {
  const { items } = demoScriptCatalog();
  const script = items.find((item) => item.id === String(scriptId || ""));
  if (!script) throw httpError(404, "演示话术不存在");
  if (script.domain !== "restaurant") throw httpError(400, "内容员工的样例请在内容工作台保存");
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError(400, "任务编号无效");
  const task = q.get(
    `SELECT t.id,t.title,t.requirement,t.status,c.body output_body,c.title output_title,s.employee_idx
     FROM agent_tasks t
     LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
     LEFT JOIN specialists s ON s.id=t.specialist_id
     WHERE t.tenant_id=? AND t.id=?`,
    tenantId,
    id,
  );
  if (!task) throw httpError(404, "任务不存在");
  if (Number(task.employee_idx) !== script.employeeIdx) {
    throw httpError(400, `这单不是${script.person}做的，不能存为这条话术的样例`);
  }
  if (!["已完成", "待审阅"].includes(String(task.status || ""))) {
    throw httpError(409, "只有已交付的任务才能存为样例");
  }
  const body = readableBody(task.output_body, {
    title: task.output_title || task.title,
    requirement: task.requirement,
  });
  if (!body || body.length < 40) throw httpError(409, "这单没有可读的报告正文");
  q.run(
    `INSERT INTO employee_demo_samples(tenant_id,script_id,employee_idx,task_id,task_title,body,captured_by,captured_at)
     VALUES(?,?,?,?,?,?,?,datetime('now','localtime'))
     ON CONFLICT(tenant_id,script_id) DO UPDATE SET employee_idx=excluded.employee_idx,task_id=excluded.task_id,
       task_title=excluded.task_title,body=excluded.body,captured_by=excluded.captured_by,captured_at=excluded.captured_at`,
    tenantId,
    script.id,
    script.employeeIdx,
    id,
    String(task.title || "").slice(0, 100),
    body.slice(0, SAMPLE_MAX_CHARS),
    Number(user?.id) || null,
  );
  return getDemoSample(script.id, tenantId);
}
