import { useState } from 'react';
import { Alert, Button, Collapse, Popconfirm, Space, Tag, Typography } from 'antd';
import { api } from '../api/client';
import type { EmployeeWorkbenchRun } from '../api/employeeWorkbenchTypes';

export default function ContentXhsVersions({
  run,
  onSelected,
}: {
  run: EmployeeWorkbenchRun;
  onSelected: () => Promise<unknown>;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const draft = run.xhsDraft;
  if (!draft) return null;
  const select = async (versionId: string) => {
    setSaving(versionId);
    setError('');
    try {
      await api.post(`/employee-workbench/content/3/runs/${run.id}/select-version`, { versionId });
      const refreshed = await onSelected();
      if (!refreshed) setError('选择已保存，但详情刷新失败，请点击刷新后核对所选版本。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '选择失败，请刷新后重试');
    } finally {
      setSaving(null);
    }
  };
  return (
    <section className="ewb-xhs-versions" aria-label="小红书策略版本">
      <Alert
        type="info"
        showIcon
        message={draft.selectedVersionId ? '已选择发布版本' : '请选择要发布的策略版本'}
        description="自评分仅为模型建议，不代表真实效果。先采纳产出，再由老板选择版本；发布包保留对应标题、封面文案、正文、标签和首评。登记发布或回填数据后不能换版。"
      />
      {error && <Alert type="error" showIcon message="未能选择版本" description={error} />}
      <Collapse
        items={draft.versions.map(version => ({
          key: version.versionId,
          label: (
            <Space wrap>
              <strong>{version.strategy}</strong>
              <span>{version.title}</span>
              {version.recommended && <Tag>自评推荐</Tag>}
              {draft.selectedVersionId === version.versionId && <Tag color="success">已选版本</Tag>}
            </Space>
          ),
          children: (
            <div className="ewb-xhs-version-detail">
              <Typography.Text strong>封面文案：{version.cover_text}</Typography.Text>
              <div className="ewb-xhs-body">{version.body}</div>
              <Space wrap>
                {version.tags.map(tag => (
                  <Tag key={tag}>#{tag}</Tag>
                ))}
              </Space>
              <div>首评：{version.comment_prompt}</div>
              <div>结构参考：{version.framework_ref}</div>
              <div>
                自评：钩子 {version.self_score.hook}/5 · 可信 {version.self_score.credibility}/5 · 转化{' '}
                {version.self_score.conversion}/5
              </div>
              <Typography.Text type="secondary">{version.self_score.note}</Typography.Text>
              <div>
                事实依据：
                {version.facts_used.map(fact => fact.claim).join('；') || '尚无可公开事实，请在发布前补齐并重新生成'}
              </div>
              {draft.canSelect && (
                <Popconfirm
                  title="选择这版用于手动发布？"
                  description="这会更新对应内容和发布包，不会替你发布到平台。"
                  onConfirm={() => select(version.versionId)}
                  okText="确认选择"
                  cancelText="取消"
                  disabled={saving !== null || draft.selectedVersionId === version.versionId}
                >
                  <Button
                    type="primary"
                    loading={saving === version.versionId}
                    disabled={saving !== null || draft.selectedVersionId === version.versionId}
                  >
                    {draft.selectedVersionId === version.versionId ? '当前发布版本' : '选择此版'}
                  </Button>
                </Popconfirm>
              )}
            </div>
          ),
        }))}
      />
      {draft.contentId && (
        <Button href={`/content?publishAssistant=${draft.contentId}&assistantTab=pack`}>打开所选版本发布包</Button>
      )}
    </section>
  );
}
