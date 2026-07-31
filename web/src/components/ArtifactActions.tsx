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

  const generate = async (format: string) => {
    if (!content?.trim()) return message.warning('没有可生成文件的内容');
    setWorking(format);
    try {
      const out = await api.post('/files/artifacts/generate', { title, content, format, sourceType, sourceId });
      setArtifact(out);
      onGenerated?.();
      message.success(`${FORMAT_ITEMS.find(x => x.key === format)?.label || format} 已生成并进入产出档案`);
      const link = document.createElement('a');
      link.href = safeUrl(out.fileUrl);
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
    <Space size={4}>
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
