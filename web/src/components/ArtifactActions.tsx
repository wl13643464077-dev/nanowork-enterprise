import { useState } from 'react';
import { Button, Dropdown, message, Space, Tooltip } from 'antd';
import { DownloadOutlined, FolderAddOutlined } from '@ant-design/icons';
import { api, safeUrl } from '../api/client';

const FORMAT_ITEMS = [
  { key: 'docx', label: 'Word 文档 (.docx)' },
  { key: 'pdf', label: 'PDF 报告 (.pdf)' },
  { key: 'xlsx', label: 'Excel 表格 (.xlsx)' },
  { key: 'pptx', label: 'PPT 演示 (.pptx)' },
];

const AUTHORITATIVE_SOURCES = new Set(['agent_task', 'content_employee_run']);

type Deliverable = {
  id: number;
  format: string;
  label?: string;
  fileName?: string;
  downloadUrl: string;
  size?: number;
  reused?: boolean;
};

function normalizeDeliverables(value: unknown): Deliverable[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Deliverable =>
      !!item &&
      typeof item === 'object' &&
      Number.isSafeInteger(Number((item as Deliverable).id)) &&
      typeof (item as Deliverable).format === 'string' &&
      typeof (item as Deliverable).downloadUrl === 'string',
  );
}

export function ArtifactActions({
  title,
  content,
  sourceType,
  sourceId,
  onGenerated,
  compact = true,
}: {
  title: string;
  content: string;
  sourceType: string;
  sourceId?: number | null;
  onGenerated?: () => void;
  compact?: boolean;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<any>(null);
  const authoritativeSource = AUTHORITATIVE_SOURCES.has(sourceType) && Number.isSafeInteger(Number(sourceId));

  const generate = async (format: string) => {
    if (!content?.trim()) return message.warning('没有可生成文件的内容');
    setWorking(format);
    try {
      const out = authoritativeSource
        ? await api.post('/files/artifacts/source', { sourceType, sourceId, formats: [format] })
        : await api.post('/files/artifacts/generate', { title, content, format, sourceType, sourceId });
      const generated = authoritativeSource ? normalizeDeliverables(out?.deliverables) : [];
      const nextArtifact = authoritativeSource ? generated[0] : out;
      setArtifact(nextArtifact);
      onGenerated?.();
      message.success(`${FORMAT_ITEMS.find(x => x.key === format)?.label || format} 已生成并进入产出档案`);
      const link = document.createElement('a');
      link.href = safeUrl(nextArtifact?.downloadUrl || nextArtifact?.fileUrl);
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.click();
    } finally {
      setWorking(null);
    }
  };

  const archive = async () => {
    if (!artifact?.id) return;
    await api.post(`/files/artifacts/${artifact.id}/archive`, { category: '员工产出' });
    message.success('已入档知识库，后续对话可抽调引用');
    setArtifact((a: any) => ({ ...a, archived: true }));
    onGenerated?.();
  };

  return (
    <Space size={4} wrap>
      <Dropdown menu={{ items: FORMAT_ITEMS, onClick: ({ key }) => generate(key) }} trigger={['click']}>
        <Tooltip title="生成真实可下载文件并保存到产出档案">
          <Button size={compact ? 'small' : 'middle'} type="text" icon={<DownloadOutlined />} loading={!!working}>
            生成文件
          </Button>
        </Tooltip>
      </Dropdown>
      {artifact && !artifact.archived && (
        <Tooltip title="把本次产出写入知识库，后续AI可调用">
          <Button size={compact ? 'small' : 'middle'} type="text" icon={<FolderAddOutlined />} onClick={archive}>
            入档
          </Button>
        </Tooltip>
      )}
    </Space>
  );
}
