import { useRef, useState } from 'react';
import { Button, Empty, List, message, Modal, Space, Tag, Tooltip } from 'antd';
import { CloseOutlined, FolderOpenOutlined, PaperClipOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { api, notifyCredits } from '../api/client';

export const BUSINESS_FILE_ACCEPT = '.txt,.md,.csv,.tsv,.json,.doc,.docx,.xls,.xlsx,.pdf,.png,.jpg,.jpeg,.webp,.gif';

export interface UploadedFileRef {
  id: number;
  name: string;
  ext?: string;
  file_url?: string;
  preview?: string;
  readable?: boolean;
  extract_mode?: string;
  size?: number;
}

function fileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () =>
      resolve(
        String(reader.result || '')
          .split(',')
          .pop() || '',
      );
    reader.readAsDataURL(file);
  });
}

export function UnifiedFilePicker({
  files,
  onChange,
  purpose = 'chat',
  maxFiles = 6,
  multiple = true,
  compact = false,
  label = '上传文件',
}: {
  files: UploadedFileRef[];
  onChange: (files: UploadedFileRef[]) => void;
  purpose?: string;
  maxFiles?: number;
  multiple?: boolean;
  compact?: boolean;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryFiles, setLibraryFiles] = useState<UploadedFileRef[]>([]);

  const pick = async (selected: FileList | null) => {
    const list = Array.from(selected || []);
    if (!list.length) return;
    if (files.length + list.length > maxFiles) {
      message.warning(`最多同时使用 ${maxFiles} 个文件`);
      return;
    }
    setUploading(true);
    const next = [...files];
    try {
      for (const file of list) {
        if (file.size > 15 * 1024 * 1024) {
          message.warning(`${file.name} 超过15MB，已跳过`);
          continue;
        }
        try {
          const b64 = await fileAsBase64(file);
          const result = await api.post('/files/upload', {
            name: file.name,
            mime: file.type,
            b64,
            purpose,
            recognize: true,
          });
          if (result.billing) notifyCredits(result.billing.balance);
          next.push(result.file);
          onChange(next.slice(-maxFiles));
          message.success(`${file.name} 已上传并读取`);
        } catch (error: any) {
          message.error(`${file.name} 上传失败：${error?.message || '请检查文件后重试'}`);
        }
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const openLibrary = async () => {
    setLibraryOpen(true);
    setLibraryLoading(true);
    try {
      const rows = await api.get('/files?limit=50');
      setLibraryFiles(Array.isArray(rows) ? rows : []);
    } finally {
      setLibraryLoading(false);
    }
  };

  const addFromLibrary = (file: UploadedFileRef) => {
    if (files.some(item => item.id === file.id)) return;
    if (files.length >= maxFiles) {
      message.warning(`最多同时使用 ${maxFiles} 个文件`);
      return;
    }
    onChange([...files, file]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 5 : 8 }}>
      <input
        ref={inputRef}
        type="file"
        accept={BUSINESS_FILE_ACCEPT}
        multiple={multiple}
        style={{ display: 'none' }}
        onChange={e => pick(e.target.files)}
      />
      <Space size={6} wrap>
        <Tooltip title="支持Word、PDF、表格、文本和图片，上传后自动提取可读内容">
          <Button
            size={compact ? 'small' : 'middle'}
            icon={uploading ? <UploadOutlined spin /> : <PaperClipOutlined />}
            loading={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {label}
          </Button>
        </Tooltip>
        <Tooltip title="选择此前已上传并读取的文件">
          <Button size={compact ? 'small' : 'middle'} icon={<FolderOpenOutlined />} onClick={openLibrary}>
            文件库
          </Button>
        </Tooltip>
      </Space>
      {!!files.length && (
        <Space size={[5, 5]} wrap>
          {files.map(file => (
            <Tooltip
              key={file.id}
              title={`${file.extract_mode || (file.readable ? '已读取' : '已存档')} · ${file.preview || '暂无预览'}`}
            >
              <Tag
                color={file.readable ? 'blue' : 'orange'}
                closable
                closeIcon={<CloseOutlined />}
                onClose={e => {
                  e.preventDefault();
                  onChange(files.filter(x => x.id !== file.id));
                }}
                style={{ maxWidth: 240 }}
              >
                {file.ext && <span style={{ textTransform: 'uppercase' }}>{file.ext} · </span>}
                {file.name}
              </Tag>
            </Tooltip>
          ))}
        </Space>
      )}
      <Modal open={libraryOpen} title="选择历史文件" footer={null} width={640} onCancel={() => setLibraryOpen(false)}>
        <List
          loading={libraryLoading}
          dataSource={libraryFiles}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史文件" /> }}
          renderItem={file => {
            const selected = files.some(item => item.id === file.id);
            return (
              <List.Item
                actions={[
                  <Button
                    key="select"
                    size="small"
                    type={selected ? 'default' : 'primary'}
                    disabled={selected}
                    icon={selected ? undefined : <PlusOutlined />}
                    onClick={() => addFromLibrary(file)}
                  >
                    {selected ? '已选择' : '选择'}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={file.name}
                  description={`${String(file.ext || '').toUpperCase()} · ${file.extract_mode || (file.readable ? '已读取' : '已存档')} · ${file.preview || '暂无内容预览'}`}
                />
              </List.Item>
            );
          }}
        />
      </Modal>
    </div>
  );
}
