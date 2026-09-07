import { useRef, useState } from 'react';
import { Button, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { storeHeaders } from '../api/store-context';

export default function NativeDeliverableDownloadButton({
  url,
  name,
  label = '一键打包下载',
}: {
  url?: string | null;
  name?: string | null;
  label?: string;
}) {
  const [downloading, setDownloading] = useState(false);
  const pending = useRef(false);
  if (!url || !/^\/api\/content\/native-deliverables\/(?:xhs|sales)\/[1-9]\d*\/download$/.test(url)) return null;
  const download = async () => {
    if (pending.current) return;
    pending.current = true;
    setDownloading(true);
    let objectUrl: string | undefined;
    try {
      const response = await fetch(url, { credentials: 'same-origin', headers: storeHeaders() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `打包下载失败（${response.status}）`);
      }
      if (!/^application\/(?:zip|x-zip-compressed)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        throw new Error('返回的文件不是发布包，请刷新结果后再试。');
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('发布包内容为空，请刷新结果后再试。');
      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      const safeName = (name || '数字员工发布包.zip').replace(/[\\/:*?"<>|]/g, '_');
      anchor.download = /\.zip$/i.test(safeName) ? safeName : `${safeName}.zip`;
      anchor.click();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '打包下载失败，请重试。');
    } finally {
      if (objectUrl) {
        const completedUrl = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(completedUrl), 1000);
      }
      pending.current = false;
      setDownloading(false);
    }
  };
  return (
    <Button icon={<DownloadOutlined />} loading={downloading} onClick={() => void download()}>
      {label}
    </Button>
  );
}
