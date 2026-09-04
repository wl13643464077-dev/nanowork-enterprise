import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Popconfirm, Select, Space, Spin, Tag, Typography, message } from 'antd';
import { api } from '../api/client';
import type { EmployeeWorkbenchRun } from '../api/employeeWorkbenchTypes';

const TARGETS: Record<string, string> = {
  title: '标题 → 撰稿人',
  hook: '开头 → 撰稿人',
  structure: '结构 → 撰稿人',
  cta: '行动号召 → 撰稿人',
  tags: '标签 → 撰稿人',
  cover: '封面 → 封面师',
  video_hook: '视频开场 → AI带货员',
};

export function ContentRetroSourceSelect({
  value,
  onChange,
}: {
  value?: number | null;
  onChange?: (id: number | null) => void;
}) {
  const [sources, setSources] = useState<Array<{ id: number; title: string }>>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api
      .get('/employee-workbench/content/9/retrospective-sources', { silent: true })
      .then((result: { contents: typeof sources }) => {
        if (!cancelled) setSources(result.contents);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || '回填内容加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);
  return (
    <Space direction="vertical" className="ewb-content-learning">
      <Select
        aria-label="选择已回填的发布内容"
        value={value}
        allowClear
        showSearch
        optionFilterProp="label"
        loading={loading}
        onChange={next => onChange?.(next ?? null)}
        placeholder="选择发布内容，服务端自动读取对应回填数据"
        options={sources.map(item => ({ value: item.id, label: `#${item.id} ${item.title}` }))}
        notFoundContent={loading ? <Spin size="small" /> : '暂无已回填内容，请先到发布助手登记并回填'}
      />
      {error && <Alert type="warning" showIcon message={error} />}
      <Button
        size="small"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          setError('');
          setRevision(current => current + 1);
        }}
      >
        刷新回填内容
      </Button>
    </Space>
  );
}

export function ContentRetroChanges({
  run,
  onChanged,
}: {
  run: EmployeeWorkbenchRun;
  onChanged: () => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const retro = run.retrospective;
  if (!retro) return null;
  const adopt = async () => {
    setSaving(true);
    try {
      await api.post(`/employee-workbench/content/9/runs/${run.id}/adopt-changes`, { indexes: selected });
      setSelected([]);
      const updated = await onChanged();
      if (updated) message.success('所选改法已采纳，仅影响对应内容员工的后续任务');
      else message.warning('采纳已保存，但详情刷新失败，请刷新后查看生效状态');
    } catch {
      /* API client displays the error; keep selection for retry. */
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="ewb-panel ewb-content-learning">
      <Typography.Title level={5}>下一稿改法 · 人工采纳</Typography.Title>
      <Alert
        type="info"
        showIcon
        message={`依据内容 #${retro.contentId} 的人工回填；平台未核验`}
        description="先审阅采纳复盘，再勾选具体改法。改法不会自动生效，不代表策略导致效果。已生效心得可在目标员工工作台停用。"
      />
      {retro.changes.map(change => (
        <div className="ewb-panel" key={change.index}>
          <Checkbox
            checked={selected.includes(change.index)}
            disabled={!retro.canAdopt || !!change.noteId || saving}
            onChange={event =>
              setSelected(current =>
                event.target.checked ? [...current, change.index] : current.filter(index => index !== change.index),
              )
            }
          >
            {TARGETS[change.target] || change.target}
          </Checkbox>
          {change.noteId && <Tag>{change.noteStatus === 'active' ? '已生效' : '已停用'}</Tag>}
          <p>{change.change}</p>
          <Typography.Text type="secondary">依据：{change.evidence}</Typography.Text>
        </div>
      ))}
      <Popconfirm
        title={`确认采纳所选 ${selected.length} 条改法？`}
        description="仅写入对应内容员工的心得，不触发收费调用或发布。"
        okText="确认采纳"
        cancelText="取消"
        onConfirm={adopt}
        disabled={!retro.canAdopt || !selected.length || saving}
      >
        <Button type="primary" loading={saving} disabled={!retro.canAdopt || !selected.length}>
          采纳所选改法
        </Button>
      </Popconfirm>
    </section>
  );
}

type Note = { id: number; note: string; rationale: string | null; status: string };
export function ContentEvolutionNotes({ employeeIdx }: { employeeIdx: number }) {
  const [data, setData] = useState<{ canManage: boolean; notes: Note[] } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/employee-workbench/content/${employeeIdx}/evolution-notes`, { silent: true })
      .then((result: { canManage: boolean; notes: Note[] }) => {
        if (!cancelled) {
          setData(result);
          setError('');
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || '心得读取失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [employeeIdx, revision]);
  const retire = async (id: number) => {
    setSaving(id);
    try {
      await api.post(`/employee-workbench/content/${employeeIdx}/evolution-notes/${id}/retire`, {});
      message.success('已停用，后续新任务不再引用');
      setLoading(true);
      setRevision(current => current + 1);
    } catch {
      /* client already displays the error */
    } finally {
      setSaving(null);
    }
  };
  return (
    <section className="ewb-panel ewb-content-learning">
      <Typography.Title level={5}>已采纳的内容心得</Typography.Title>
      <Typography.Paragraph type="secondary">
        仅应用于本企业、当前员工的后续任务；不改写已开始的任务，也不能覆盖事实、安全和审批边界。
      </Typography.Paragraph>
      <Button
        size="small"
        loading={loading}
        onClick={() => {
          setLoading(true);
          setRevision(current => current + 1);
        }}
      >
        刷新心得
      </Button>
      {error && <Alert type="warning" message={error} showIcon />}
      {!data && loading ? (
        <Spin />
      ) : data?.notes.length ? (
        data.notes.map(note => (
          <div key={note.id} className="ewb-panel">
            <Tag>{note.status === 'active' ? '生效中' : '已停用'}</Tag>
            <p>{note.note}</p>
            {note.rationale && <p>{note.rationale}</p>}
            {data.canManage && note.status === 'active' && (
              <Popconfirm
                title="停用这条心得？"
                description="只影响后续新任务；历史任务保留原快照。"
                okText="确认停用"
                cancelText="取消"
                onConfirm={() => retire(note.id)}
              >
                <Button size="small" loading={saving === note.id}>
                  停用
                </Button>
              </Popconfirm>
            )}
          </div>
        ))
      ) : (
        !error && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无采纳的心得：复盘官完成复盘后，由老板选择改法" />
        )
      )}
    </section>
  );
}
