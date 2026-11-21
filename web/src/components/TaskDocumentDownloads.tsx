import { useRef, useState } from 'react';
import { Button, message } from 'antd';
import { FilePdfOutlined, FileWordOutlined } from '@ant-design/icons';
import { api } from '../api/client';

type Format = 'pdf' | 'docx';
type Deliverable = { format: string; downloadUrl: string; fileName?: string; downloadAvailable?: boolean };

export default function TaskDocumentDownloads({
  availability,
  deliverables = [],
  onGenerated,
}: {
  availability?: { canGenerate?: boolean; generateUrl?: string; message?: string };
  deliverables?: Deliverable[];
  onGenerated?: () => void;
}) {
  const [working, setWorking] = useState<Format | null>(null);
  const busy = useRef(false);
  const generateUrl = String(availability?.generateUrl || '');
  const canGenerate =
    availability?.canGenerate === true &&
    /^\/api\/files\/artifacts\/source\/(agent_task|agent_task_revision|content_employee_run)\/[1-9]\d*$/u.test(
      generateUrl,
    );
  if (!canGenerate && !deliverables.some(item => ['pdf', 'docx'].includes(item.format))) return null;

  const download = async (format: Format) => {
    if (busy.current) return;
    busy.current = true;
    setWorking(format);
    try {
      let file = deliverables.find(item => item.format === format && item.downloadAvailable !== false);
      if (canGenerate) {
        // The source endpoint resolves the owned, current task body on the
        // server and reuses an existing matching artifact. Never post UI text.
        const payload = await api.post(generateUrl.slice(4), { formats: [format] }, { silent: true });
        file = payload?.deliverables?.find((item: Deliverable) => item.format === format);
      }
      if (!file || !/^\/api\/files\/artifacts\/[1-9]\d*\/download(?:\?.*)?$/u.test(file.downloadUrl)) {
        throw new Error('文件暂未就绪，请稍后重新下载');
      }
      const link = document.createElement('a');
      link.href = file.downloadUrl;
      link.download = file.fileName || `任务正文.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      onGenerated?.();
    } catch (error: any) {
      message.error(error?.message || '下载失败，请稍后重试');
    } finally {
      busy.current = false;
      setWorking(null);
    }
  };

  return (
    <div className="task-center-document-downloads" role="group" aria-label="下载正文文档">
      <Button
        icon={<FilePdfOutlined aria-hidden />}
        loading={working === 'pdf'}
        disabled={!!working && working !== 'pdf'}
        onClick={() => void download('pdf')}
      >
        下载 PDF
      </Button>
      <Button
        icon={<FileWordOutlined aria-hidden />}
        loading={working === 'docx'}
        disabled={!!working && working !== 'docx'}
        onClick={() => void download('docx')}
      >
        下载 Word（DOCX）
      </Button>
    </div>
  );
}
