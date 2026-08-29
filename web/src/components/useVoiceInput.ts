import { useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { api } from '../api/client';

// 语音输入公共 hook（浏览器 Web Speech API）：识别在本机浏览器完成，
// 不经过服务器，也不产生积分消耗。
//
// 连续聆听设计（修复“还没说完就断了”）：
// - continuous 模式：说话中间的停顿不会结束聆听；
// - 浏览器仍可能因长静默/内部超时自行结束会话，此时把已识别文字沉淀为
//   基线并立即无缝重启新会话继续听，老板无感知；
// - 只有两种情况才真正停止：用户再点一次按钮，或达到 90 秒兜底时长；
// - 追加模式：识别结果接在既有文字后面，边说边上屏（interim 实时刷新）。
// 使用方通过公共类名 `nw-voice-listening` 获得聆听中的脉冲视觉（theme.css）。
const MAX_LISTEN_MS = 90000;

// 语音意图整理：浏览器转写常有同音错字/丢字，说完后交给真实 AI 按餐饮
// 经营语境还原真实意图（轻量调用，几积分）。失败时保留原文，绝不阻塞。
export async function refineVoiceIntent(rawText: string): Promise<string> {
  const text = String(rawText || '').trim();
  if (text.length < 4) return text;
  try {
    const payload = await api.post('/employees/voice-intent', { text });
    const refined = String(payload?.text || '').trim();
    return refined || text;
  } catch {
    return text;
  }
}

export function useVoiceInput(
  getBaseText: () => string,
  applyText: (nextText: string) => void,
  options?: { onFinish?: (finalText: string) => void },
) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const baseTextRef = useRef('');
  const sessionTextRef = useRef('');
  const manualStopRef = useRef(false);
  const maxTimerRef = useRef<number | null>(null);
  const onFinishRef = useRef(options?.onFinish);
  const onFinish = options?.onFinish;
  const heardAnythingRef = useRef(false);

  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  // 组件卸载时终止聆听（标记手动停，阻止 onend 里的自动续听）
  useEffect(
    () => () => {
      manualStopRef.current = true;
      if (maxTimerRef.current) window.clearTimeout(maxTimerRef.current);
      recognitionRef.current?.stop();
    },
    [],
  );

  const composedText = () => {
    const base = baseTextRef.current;
    const session = sessionTextRef.current;
    if (!base) return session;
    if (!session) return base;
    return `${base}，${session}`;
  };

  const finishListening = () => {
    if (maxTimerRef.current) {
      window.clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    setListening(false);
  };

  const startSession = (SpeechRecognitionCtor: new () => any) => {
    const recognition = new SpeechRecognitionCtor();
    recognitionRef.current = recognition;
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    // 关键：连续模式下说话停顿不结束会话，长句、想一下再说都不会被切断
    recognition.continuous = true;
    sessionTextRef.current = '';
    recognition.onresult = (event: any) => {
      let spoken = '';
      for (let index = 0; index < event.results.length; index += 1) {
        spoken += event.results[index][0]?.transcript || '';
      }
      sessionTextRef.current = spoken.trim();
      if (sessionTextRef.current) {
        heardAnythingRef.current = true;
        applyText(composedText());
      }
    };
    recognition.onerror = (event: any) => {
      if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
        manualStopRef.current = true;
        message.warning('麦克风权限被拒绝，请在浏览器地址栏允许使用麦克风后重试');
      }
      // no-speech / network 等瞬断交给 onend 的自动续听处理，不打扰用户
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      // 本会话已识别的文字沉淀为基线；续听的新会话在此基础上追加
      baseTextRef.current = composedText();
      sessionTextRef.current = '';
      if (manualStopRef.current) {
        finishListening();
        // 说完收尾：把最终文本交给使用方（如 AI 意图整理）
        if (heardAnythingRef.current && baseTextRef.current) {
          onFinishRef.current?.(baseTextRef.current);
        }
        return;
      }
      // 浏览器自行结束会话（长静默/内部超时）：无缝续听
      try {
        startSession(SpeechRecognitionCtor);
      } catch {
        finishListening();
        if (heardAnythingRef.current && baseTextRef.current) {
          onFinishRef.current?.(baseTextRef.current);
        }
      }
    };
    recognition.start();
  };

  const toggleVoice = () => {
    if (listening) {
      manualStopRef.current = true;
      recognitionRef.current?.stop();
      // onend 会做最终收尾；这里立即反馈按钮状态，避免用户以为没点上
      finishListening();
      return;
    }
    const SpeechRecognitionCtor =
      (window as unknown as Record<string, any>).webkitSpeechRecognition ||
      (window as unknown as Record<string, any>).SpeechRecognition;
    if (!SpeechRecognitionCtor) {
      message.info('当前浏览器不支持语音输入，请使用 Chrome、Edge 或 Safari');
      return;
    }
    manualStopRef.current = false;
    heardAnythingRef.current = false;
    baseTextRef.current = String(getBaseText() || '').trim();
    try {
      startSession(SpeechRecognitionCtor);
    } catch {
      message.info('语音输入启动失败，请重试');
      return;
    }
    setListening(true);
    // 兜底：最长聆听 90 秒，防止忘记关麦
    maxTimerRef.current = window.setTimeout(() => {
      if (!recognitionRef.current) return;
      manualStopRef.current = true;
      recognitionRef.current.stop();
      finishListening();
      message.info('已聆听 90 秒自动停止；内容都在输入框里，可继续点麦克风补充');
    }, MAX_LISTEN_MS);
  };

  return { listening, toggleVoice };
}
