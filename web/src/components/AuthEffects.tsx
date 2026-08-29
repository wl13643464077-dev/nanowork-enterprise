import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { SoundOutlined, AudioMutedOutlined } from '@ant-design/icons';
import './AuthEffects.css';

/**
 * AuthEffects —— 登录页增强动效与音效（全部可降级）。
 * - LightStreams：向上流动的光带画布，呼应"数据回流"叙事；
 * - WorkforceConstellation：真实数字员工头像星阵（生成肖像，加载失败自动隐藏该枚徽章）；
 * - SoundToggle + SoundKit：WebAudio 纯合成轻音效（零外部资源），默认关闭，用户手动开启。
 * prefers-reduced-motion 下：画布静止、星阵停止浮动。
 */

/* ================= WebAudio 轻音效引擎 ================= */
class SoundKit {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambient: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode } | null = null;
  enabled = false;

  private ensure() {
    if (!this.ctx) {
      const AC =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.16;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.startAmbient();
    else this.stopAmbient();
  }

  /** 环境音：极低音量双正弦缓慢拍频，安静的能量流 */
  private startAmbient() {
    const ctx = this.ensure();
    if (this.ambient || !this.master) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 2.4);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 110;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 110.7;
    osc.connect(gain);
    osc2.connect(gain);
    gain.connect(this.master);
    osc.start();
    osc2.start();
    this.ambient = { osc, osc2, gain };
  }

  private stopAmbient() {
    if (!this.ambient || !this.ctx) return;
    const { osc, osc2, gain } = this.ambient;
    gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.6);
    window.setTimeout(() => {
      try {
        osc.stop();
        osc2.stop();
      } catch {
        /* 已停止 */
      }
    }, 700);
    this.ambient = null;
  }

  private blip(freq: number, dur = 0.09, type: OscillatorType = 'sine', vol = 0.5) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!this.master) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + dur + 0.05);
  }

  hover() {
    this.blip(1240, 0.05, 'sine', 0.18);
  }
  press() {
    this.blip(520, 0.08, 'triangle', 0.4);
  }
  success() {
    if (!this.enabled) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      window.setTimeout(() => this.blip(f, 0.22, 'sine', 0.42), i * 90),
    );
  }
  dispose() {
    this.stopAmbient();
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.master = null;
  }
}

const SOUND_KEY = 'nanowork_login_sound';

export function useLoginSound() {
  const kitRef = useRef<SoundKit | null>(null);
  const [soundOn, setSoundOn] = useState(false);

  useEffect(() => {
    kitRef.current = new SoundKit();
    return () => {
      kitRef.current?.dispose();
      kitRef.current = null;
    };
  }, []);

  const toggle = useCallback(() => {
    setSoundOn(prev => {
      const next = !prev;
      localStorage.setItem(SOUND_KEY, next ? '1' : '0');
      kitRef.current?.setEnabled(next);
      return next;
    });
  }, []);

  return {
    soundOn,
    toggle,
    press: () => kitRef.current?.press(),
    success: () => kitRef.current?.success(),
    hover: () => kitRef.current?.hover(),
  };
}

export function SoundToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="au-sound-btn"
      aria-pressed={on}
      aria-label={on ? '关闭音效' : '开启音效'}
      title={on ? '关闭音效' : '开启音效'}
      onClick={onToggle}
    >
      {on ? <SoundOutlined /> : <AudioMutedOutlined />}
      <span>{on ? '音效开' : '音效关'}</span>
    </button>
  );
}

/* ================= 光流画布 ================= */
export function LightStreams() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0,
      height = 0,
      raf = 0;
    type Streak = { x: number; y: number; len: number; speed: number; alpha: number; hue: number; drift: number };
    let streaks: Streak[] = [];

    const spawn = (): Streak => ({
      x: Math.random() * width,
      y: height + Math.random() * height * 0.4,
      len: 40 + Math.random() * 130,
      speed: 0.35 + Math.random() * 1.2,
      alpha: 0.04 + Math.random() * 0.18,
      hue: 205 + Math.random() * 18,
      drift: (Math.random() - 0.5) * 0.2,
    });

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(18, Math.min(48, Math.round(width / 34)));
      streaks = Array.from({ length: count }, spawn).map(s => ({ ...s, y: Math.random() * height }));
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      for (const s of streaks) {
        const grad = context.createLinearGradient(s.x, s.y, s.x, s.y + s.len);
        grad.addColorStop(0, `hsla(${s.hue}, 92%, 72%, ${s.alpha})`);
        grad.addColorStop(1, 'hsla(210, 90%, 60%, 0)');
        context.strokeStyle = grad;
        context.lineWidth = 1.4;
        context.beginPath();
        context.moveTo(s.x, s.y);
        context.lineTo(s.x + s.drift * s.len * 0.4, s.y + s.len);
        context.stroke();
        if (!reduced) {
          s.y -= s.speed;
          s.x += s.drift;
          if (s.y + s.len < -20) Object.assign(s, spawn(), { y: height + 20 });
        }
      }
      if (!reduced) raf = window.requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} className="au-streams" aria-hidden="true" />;
}

/* ================= 员工头像星阵 ================= */
// 真实岗位与生成肖像；头像加载失败时整枚徽章淡出（不出现破图）
const WORKFORCE = [
  { file: 'emp-01', name: '赵先机', role: '市场机会研究' },
  { file: 'emp-08', name: '王菜单', role: '菜单架构规划' },
  { file: 'emp-17', name: '朱哈普', role: 'HACCP 食安' },
  { file: 'emp-27', name: '严订货', role: '需求预测补货' },
  { file: 'emp-35', name: '邹翻台', role: '桌台收益管理' },
  { file: 'emp-42', name: '苏种草', role: '社媒与UGC' },
  { file: 'emp-50', name: '昌本利', role: '单店损益' },
  { file: 'emp-60', name: '店小满', role: '超级店长' },
  { file: 'crew-00', name: '趋势官', role: '热点选题' },
  { file: 'crew-03', name: '撰稿人', role: '文案初稿' },
];

export function WorkforceConstellation() {
  return (
    <div className="au-workforce" aria-hidden="true">
      {WORKFORCE.map((member, index) => (
        <div className={`au-agent au-agent-${index}`} key={member.file} style={{ '--i': index } as CSSProperties}>
          <span className="au-agent-ring" />
          <img
            src={`/avatars/employees/${member.file}.jpg`}
            alt=""
            loading="lazy"
            onError={event => {
              (event.currentTarget.closest('.au-agent') as HTMLElement | null)?.classList.add('au-agent-hidden');
            }}
          />
          <span className="au-agent-meta">
            <b>{member.name}</b>
            <i>{member.role}</i>
          </span>
          <span className="au-agent-dot" />
        </div>
      ))}
    </div>
  );
}
