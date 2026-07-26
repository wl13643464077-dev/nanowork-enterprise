import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Empty, Spin } from 'antd';
import { api } from '../api/client';

// 读操作统一四态：loading / empty / error(+retry) / data。
// 失败不再被 .catch(()=>{}) 吞掉——错误与空态可区分，且带请求版本号防竞态：
// deps 变化或组件卸载后，旧请求的迟到响应一律丢弃，不会覆盖新数据。
export interface Query<T> {
  data: T | undefined;
  loading: boolean;
  error: string;
  empty: boolean;
  retry: () => void;
}

function isBlank(d: unknown): boolean {
  if (d === undefined || d === null) return true;
  if (Array.isArray(d)) return d.length === 0;
  if (typeof d === 'object' && 'rows' in (d as Record<string, unknown>)) {
    const rows = (d as { rows?: unknown[] }).rows;
    return !rows || rows.length === 0;
  }
  return false;
}

export function useQuery<T = unknown>(
  fetcher: string | (() => Promise<T>),
  deps: unknown[] = [],
  opts: { enabled?: boolean; isEmpty?: (d: T) => boolean } = {},
): Query<T> {
  const { enabled = true, isEmpty } = opts;
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const versionRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; }); // 每次渲染后同步最新 fetcher（先于下方 run effect 执行）

  const depsKey = JSON.stringify(deps);
  const run = useCallback(() => {
    if (!enabled) return;
    const version = ++versionRef.current;   // 只认最新一次请求的结果
    setLoading(true);
    setError('');
    const f = fetcherRef.current;
    Promise.resolve(typeof f === 'function' ? f() : api.get(f))
      .then(d => {
        if (version !== versionRef.current) return;
        setData(d as T);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (version !== versionRef.current) return;
        setError((e as Error)?.message || '加载失败');
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depsKey 代表调用方 deps，驱动重新拉取
  }, [enabled, depsKey]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) run();
    });
    const ref = versionRef;
    return () => {
      cancelled = true;
      ref.current++;
    }; // 卸载/deps变化：作废在途请求
  }, [run]);

  const empty = !loading && !error && (isEmpty ? (data === undefined || isEmpty(data)) : isBlank(data));
  return { data, loading, error, empty, retry: run };
}

// 四态占位渲染：data 就绪时返回 null，由调用方渲染正文
export function QueryStatus({ q, emptyText, height = 120 }: { q: Query<any>; emptyText?: string; height?: number }) {
  if (q.loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: height }}><Spin /></div>;
  }
  if (q.error) {
    return (
      <div style={{ minHeight: height, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <span style={{ fontSize: 12.5, color: 'var(--ui-muted)' }}>加载失败：{q.error}</span>
        <Button size="small" onClick={q.retry}>重试</Button>
      </div>
    );
  }
  if (q.empty) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span style={{ fontSize: 12 }}>{emptyText || '暂无数据'}</span>} style={{ margin: '14px 0' }} />;
  }
  return null;
}
