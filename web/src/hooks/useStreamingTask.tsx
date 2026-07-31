import { useCallback, useRef, useState } from 'react';
import { api, notifyCredits } from '../api/client';

/**
 * AI 长任务流式执行 hook。
 *
 * 背景：后端 yunwu.chatStream + ai.generate({onDelta}) 早已支持流式，且
 * /advisor/chat 与 /marshals/:id/chat 两个端点已开 SSE 通道，但前端此前只有
 * Advisor 一处在用；其余调用走普通 POST，让老板对着一个转圈干等 60-135 秒。
 *
 * 这个 hook 把「阶段进度 + 逐段增量 + 通道切换重置 + 计费联动」收成一处，
 * 让任何 AI 端点接流式都只是换一个调用。
 */

export type StreamStage = {
  key: string;
  label: string;
};

/** 通用阶段轴：与后端事件语义对齐，不编造中间态 */
export const DEFAULT_STAGES: StreamStage[] = [
  { key: 'submitted', label: '需求已提交' },
  { key: 'generating', label: 'AI 生成中' },
  { key: 'done', label: '已完成' },
];

export type StreamingState = {
  /** 是否有任务在执行 */
  running: boolean;
  /** 已累积的输出文本（逐段增长） */
  text: string;
  /** 当前阶段索引；-1 表示未开始 */
  stage: number;
  /** 是否正在接收增量（用于打字点动画） */
  typing: boolean;
  /** 失败原因；成功或未开始时为空 */
  error: string;
};

const IDLE: StreamingState = { running: false, text: '', stage: -1, typing: false, error: '' };

export function useStreamingTask() {
  const [state, setState] = useState<StreamingState>(IDLE);
  // 版本号防竞态：用户连续触发时，旧任务的增量不得污染新任务的输出
  const versionRef = useRef(0);

  const reset = useCallback(() => {
    versionRef.current += 1;
    setState(IDLE);
  }, []);

  /**
   * 执行一次流式任务。
   * @param url  后端 SSE 端点（自动附加 stream: true）
   * @param body 请求体
   * @param opts fallbackToPost —— 端点尚未支持 SSE 时降级为普通 POST，
   *             并从 replyField 读取整段结果，保证调用方逻辑一致。
   */
  const run = useCallback(
    async (
      url: string,
      body: Record<string, unknown>,
      opts: { fallbackToPost?: boolean; replyField?: string } = {},
    ): Promise<{ ok: boolean; text: string; meta?: Record<string, unknown> }> => {
      const version = ++versionRef.current;
      const alive = () => version === versionRef.current;
      setState({ running: true, text: '', stage: 0, typing: false, error: '' });

      try {
        const meta = await api.stream(url, { ...body, stream: true }, ev => {
          if (!alive()) return;
          // reset：服务端多通道降级时切换了通道，已输出内容作废需清屏重来
          if (ev.reset) {
            setState(prev => ({ ...prev, text: '', typing: false, stage: 1 }));
            return;
          }
          if (typeof ev.delta === 'string') {
            setState(prev => ({
              ...prev,
              stage: prev.stage < 1 ? 1 : prev.stage,
              typing: true,
              text: prev.text + ev.delta,
            }));
          }
        });

        if (!alive()) return { ok: false, text: '' };

        // 服务端可能在 done 事件里带完整正文（advisor 为资金安全先缓冲后交付）
        const finalText =
          typeof meta?.text === 'string' && meta.text
            ? meta.text
            : typeof meta?.reply === 'string' && meta.reply
              ? meta.reply
              : '';

        let resolved = '';
        setState(prev => {
          resolved = finalText || prev.text;
          return { running: false, text: resolved, stage: 2, typing: false, error: '' };
        });
        if (meta?.billing && typeof meta.billing === 'object') {
          notifyCredits((meta.billing as { balance?: number }).balance);
        }
        return { ok: true, text: resolved, meta: meta as Record<string, unknown> };
      } catch (streamErr) {
        if (!alive()) return { ok: false, text: '' };

        // 端点未开 SSE：降级为普通 POST，用户仍能拿到结果（只是没有逐字效果）
        if (opts.fallbackToPost) {
          try {
            const res = await api.post(url, body);
            if (!alive()) return { ok: false, text: '' };
            const field = opts.replyField || 'reply';
            const text = String(res?.[field] ?? '');
            setState({ running: false, text, stage: 2, typing: false, error: '' });
            if (res?.billing) notifyCredits(res.billing.balance);
            return { ok: true, text, meta: res };
          } catch (postErr) {
            if (!alive()) return { ok: false, text: '' };
            const msg = postErr instanceof Error ? postErr.message : '生成失败';
            setState({ running: false, text: '', stage: -1, typing: false, error: msg });
            return { ok: false, text: '' };
          }
        }

        const msg = streamErr instanceof Error ? streamErr.message : '生成失败';
        setState({ running: false, text: '', stage: -1, typing: false, error: msg });
        return { ok: false, text: '' };
      }
    },
    [],
  );

  return { ...state, run, reset };
}
