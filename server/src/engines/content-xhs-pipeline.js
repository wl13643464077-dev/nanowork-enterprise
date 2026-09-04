import { xhsVersionId, xhsVersionsForDisplay } from './content-xhs-output.js';

export function isXhsPipelineDraft(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'versions');
}

// Selection is server-owned. A recommendation or a first array item is never a choice.
export function selectedXhsPipelineVersion(outputs, { required = true, styled = true } = {}) {
  const draft = outputs instanceof Map ? outputs.get(3) : outputs?.[3];
  if (!isXhsPipelineDraft(draft)) return null;
  const versionId = draft.xhsSelection?.versionId;
  const original = Array.isArray(draft.versions)
    ? draft.versions.find(version => xhsVersionId(version) === versionId) : null;
  if (!original) {
    if (!required) return null;
    throw Object.assign(new Error('请先由老板选择有效的小红书版本，再继续下游工位；不能使用推荐版或任务材料代替选版'), {
      code: 'CONTENT_PIPELINE_XHS_SELECTION_REQUIRED', status: 409,
    });
  }
  const style = styled ? (outputs instanceof Map ? outputs.get(4) : outputs?.[4]) : null;
  const version = style?.body ? {
    ...original, body: style.body,
    title: Array.isArray(style.title_candidates) ? style.title_candidates[0] || original.title : original.title,
  } : { ...original };
  return { original, version, sourceVersionId: versionId, versionId: xhsVersionId(version),
    selection: draft.xhsSelection, versions: xhsVersionsForDisplay(draft), imagePlan: draft.image_plan };
}

export function xhsPipelinePromptLines(context, employeeIdx) {
  if (context.executionMode !== 'pipeline' || employeeIdx < 4) return [];
  const selected = selectedXhsPipelineVersion(context.outputs);
  if (!selected) return [];
  return [
    '【人工选定的小红书策略·仅处理这一版】',
    `源版本ID：${selected.sourceVersionId}；策略：${selected.version.strategy}。其他原稿仅供审计，不得混用或改选。`,
    `完整已选稿：${JSON.stringify(selected.version)}`,
    employeeIdx === 4
      ? '文风师只润色已选稿。首个标题即定稿标题；保留小红书短段、emoji、既有事实和提问。不得引入其他版本正文、价格或地址。'
      : employeeIdx === 8
        ? '分发官的小红书版本必须逐字保留上面的 title/body/tags，不重新选版或改写；封面文案和首评由系统原样并入最终包。其他平台可基于同一已选稿适配。'
        : '图像与封面围绕所选版本组织；原始image_plan只作建议，若服务的是其他策略需调整，不得虚构产品事实。',
  ];
}
