import { useEffect, useState } from 'react';
import { AppleFilled, DownloadOutlined, WindowsFilled } from '@ant-design/icons';
import './ClientDownloads.css';

type Release = {
  id: string;
  available: boolean;
  downloadUrl?: string;
  version?: string;
  bytes?: number;
};
const CLIENTS = [
  { id: 'mac-arm64', label: 'Mac · Apple 芯片', icon: <AppleFilled /> },
  { id: 'mac-x64', label: 'Mac · Intel 芯片', icon: <AppleFilled /> },
  { id: 'windows-x64', label: 'Windows · 64位', icon: <WindowsFilled /> },
];

export default function ClientDownloads() {
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/public/client-downloads', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Downloads unavailable');
        const data = await response.json();
        if (!Array.isArray(data.releases)) throw new Error('Downloads unavailable');
        setReleases(data.releases);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <section className="client-downloads" id="lp-downloads" aria-label="下载桌面客户端">
      <h2>下载桌面客户端</h2>
      <p>安装后登录，与网页版共用账号和工作记录。</p>
      <div className="client-downloads-links">
        {CLIENTS.map(client => {
          const release = releases.find(item => item.id === client.id);
          const url = `/downloads/clients/${client.id}`;
          const ready = !failed && release?.available && release.downloadUrl === url;
          return (
            <div className="client-downloads-option" key={client.id}>
              {ready ? (
                <a href={url} download aria-label={`下载 ${client.label} 客户端`}>
                  {client.icon}
                  <span>{client.label}</span>
                  <DownloadOutlined />
                </a>
              ) : (
                <button type="button" disabled>
                  {client.icon}
                  <span>{client.label}</span>
                </button>
              )}
              <small>
                {ready
                  ? `v${release.version} · ${Math.ceil((release.bytes || 0) / 1024 / 1024)} MB`
                  : loading
                    ? '正在读取版本…'
                    : failed
                      ? '暂时无法读取'
                      : '安装包准备中'}
              </small>
            </div>
          );
        })}
      </div>
      {failed && (
        <button
          type="button"
          className="client-downloads-retry"
          onClick={() => {
            setLoading(true);
            setFailed(false);
            setAttempt(value => value + 1);
          }}
        >
          重新读取下载版本
        </button>
      )}
    </section>
  );
}
