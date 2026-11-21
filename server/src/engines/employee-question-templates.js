// 老板提问 SOP 题库（PRD v2.2 FR-13）。题库文件 catalog/employee-question-templates.json
// 随 PRD 交付：每条问法含“为什么问 / 完整问法模板 / 可替换词 / 示例 / 你会拿到”。
// 派活输入框下方的“常用问法”标签由此提供；纯读取，无写操作。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INTENT_LABELS, normalizeIntentType } from "./employee-intent-router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EMPLOYEE_QUESTION_TEMPLATES_PATH = path.join(
  __dirname,
  "..",
  "..",
  "catalog",
  "employee-question-templates.json",
);

let cache = null;

export function loadEmployeeQuestionTemplates(file = EMPLOYEE_QUESTION_TEMPLATES_PATH) {
  if (cache && cache.file === file) return cache.data;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(data?.items)) throw new Error("老板提问题库格式不正确");
  cache = { file, data };
  return data;
}

function publicItem(item) {
  const type = normalizeIntentType(item.type) || "plan";
  return {
    id: item.id,
    type,
    typeLabel: INTENT_LABELS[type],
    why: item.why,
    template: item.template,
    slots: item.slots || [],
    exampleFilled: item.example_filled,
    youGet: item.you_get,
    demo: item.demo === true,
    isNewRule: item.addedIn === "v2.2",
    basis: item.basis ? { title: item.basis.title, date: item.basis.date } : null,
  };
}

/**
 * 某位餐饮员工的常用问法（A 级 5 条，其余 2 条，有新规问法的多 1 条）。
 */
export function questionTemplatesForEmployee(idx) {
  const employeeIdx = Number(idx);
  const data = loadEmployeeQuestionTemplates();
  const items = data.items.filter((item) => Number(item.employee) === employeeIdx).map(publicItem);
  return {
    employeeIdx,
    count: items.length,
    items,
    slotDictionary: data.slots || {},
  };
}

/**
 * 用“我的版本”里保存的值替换模板里的 {槽位}。没有值的槽位保持原样，前端高亮。
 */
export function fillQuestionTemplate(template, values = {}) {
  return String(template || "").replace(/\{([^{}]{1,12})\}/gu, (whole, key) => {
    const value = values?.[key];
    return value == null || String(value).trim() === "" ? whole : String(value).trim().slice(0, 40);
  });
}
