import { useCallback, useEffect, useState } from 'react';
import { Avatar, Button, Empty, message } from 'antd';
import { BellOutlined, DesktopOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { api, clearAuth } from '../../api/client';
import { REALTIME_EVENTS, useRealtimeEvent } from '../../hooks/useRealtimeEvents';
import { mobilePath, toMobilePath } from './mobileRoutes';
import './mobile.css';

// 我的：身份、积分、通知中心（复用 /sys/notifications）、切电脑版、退出登录。

const ROLE_LABEL: Record<string, string> = {
  boss: '老板',
  ops_director: '运营负责人',
  manager: '管理层',
  sales: '员工',
  admin: '系统管理员',
  partner: '合作伙伴',
};

// 通知没有 link 时按类型落到移动页；有 link 时经桌面→移动映射
const NOTIF_FALLBACK: Record<string, string> = {
  approval: mobilePath('inbox'),
  lead: mobilePath('customers'),
  follow: mobilePath('customers'),
  partner: '/execution',
  marshal: mobilePath('dispatch'),
  activity: '/activities',
  task: mobilePath('tasks'),
};

type Notice = { id: number; type?: string; title?: string; link?: string | null; read?: number; created_at?: string };

function noticeTarget(notice: Notice) {
  const mapped = toMobilePath(notice.link);
  if (mapped) return mapped;
  return NOTIF_FALLBACK[String(notice.type || '')] || null;
}

export default function MobileMe({ user, nav }: { user: any; nav: (path: string) => void }) {
  const [bal, setBal] = useState<any>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [noticesError, setNoticesError] = useState('');
  const [marking, setMarking] = useState(false);

  useEffect(() => {
    if (user.role === 'boss')
      api
        .get('/recharge/balance', { silent: true })
        .then(setBal)
        .catch(() => {});
  }, [user.role]);

  const loadNotices = useCallback(() => {
    api
      .get('/sys/notifications?size=30', { silent: true })
      .then(rows => {
        setNotices(Array.isArray(rows) ? rows : []);
        setNoticesError('');
      })
      .catch((error: any) => setNoticesError(error?.message || '通知加载失败'));
  }, []);
  useEffect(() => {
    loadNotices();
  }, [loadNotices]);
  useRealtimeEvent(REALTIME_EVENTS.notification, loadNotices);

  const unread = notices.filter(item => !item.read).length;
  const openNotice = (notice: Notice) => {
    if (!notice.read) {
      setNotices(current => current.map(item => (item.id === notice.id ? { ...item, read: 1 } : item)));
      api.post(`/sys/notifications/${notice.id}/read`, undefined, { silent: true }).catch(() => {});
    }
    const target = noticeTarget(notice);
    if (target) nav(target);
  };
  const markAllRead = async () => {
    setMarking(true);
    try {
      await api.post('/sys/notifications/read');
      message.success('已全部标为已读');
      loadNotices();
    } catch {
      // api 客户端已提示错误
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="m-stack">
      <div className="m-card m-profile">
        <Avatar size={48} className="m-avatar" icon={<UserOutlined />} />
        <div>
          <div className="m-profile-name">{user.name}</div>
          <div className="m-profile-role">
            {user.tenant?.name} · {ROLE_LABEL[String(user.role || '')] || '员工'}
          </div>
        </div>
      </div>
      {bal && (
        <div className="m-card">
          <div className="m-card-title">企业积分</div>
          <div className="m-credits">
            {(bal.credits ?? 0).toLocaleString()}
            <small> 分</small>
          </div>
          <div className="m-muted">
            累计充值 {(bal.totalRecharged ?? 0).toLocaleString()} · 已消耗 {(bal.totalSpent ?? 0).toLocaleString()}
          </div>
        </div>
      )}
      <section className="m-card" aria-label="通知中心">
        <div className="m-card-title">
          <span>
            <BellOutlined /> 通知中心{unread > 0 ? `（${unread} 条未读）` : ''}
          </span>
          {unread > 0 && (
            <Button size="small" type="text" loading={marking} onClick={() => void markAllRead()}>
              全部已读
            </Button>
          )}
        </div>
        {noticesError ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={noticesError}>
            <Button size="small" onClick={loadNotices}>
              重试
            </Button>
          </Empty>
        ) : notices.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有通知" />
        ) : (
          <div className="m-notice-list">
            {notices.map(notice => (
              <button
                key={notice.id}
                type="button"
                className={`m-notice${notice.read ? '' : ' m-notice--unread'}`}
                aria-label={`${notice.read ? '' : '未读，'}${notice.title || '通知'}`}
                onClick={() => openNotice(notice)}
              >
                <span className="m-notice-dot" aria-hidden="true" />
                <span className="m-row-main">
                  <span className="m-notice-title">{notice.title || '通知'}</span>
                  <span className="m-notice-time">
                    {' '}
                    {String(notice.created_at || '')
                      .replace('T', ' ')
                      .slice(5, 16)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <Button block icon={<DesktopOutlined />} onClick={() => nav('/')}>
        切换到电脑版（功能更全）
      </Button>
      <Button
        block
        danger
        icon={<LogoutOutlined />}
        onClick={() => {
          clearAuth();
          nav('/login');
        }}
      >
        退出登录
      </Button>
      <div className="m-footnote">纳米Work行业版 · 移动版</div>
    </div>
  );
}
