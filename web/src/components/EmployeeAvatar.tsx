import { useId } from 'react';

// 数字员工头像 v3：姓氏印章徽章（零外部素材，按 idx 确定性微调色调）。
// 迭代记录：v1 参数化五官插画 → 观感粗糙；v2 白色人形剪影 → 像"未上传头像"占位图。
// v3 采用 Linear/Notion 字母头像的中文形态——高饱和渐变徽章 + 姓氏大字，
// 类似个人印章：不会踩恐怖谷、不会像占位图、每人凭姓氏即有身份识别度。

function hashOf(seed: number) {
  let h = (seed * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = (h * 2246822519) >>> 0;
  h ^= h >>> 13;
  return h;
}

export default function EmployeeAvatar({
  idx,
  name = '',
  color = '#2c76dc',
  size = 56,
}: {
  idx: number;
  name?: string;
  color?: string;
  group?: string;
  size?: number;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const h = hashOf(idx);
  const glyph = (name || '员').trim().charAt(0) || '员';
  // 同分部同色系，但每人深浅与光源方位略有差异，避免千人一面
  const shift = ((h >> 7) % 3) * 5 - 5; // -5 / 0 / +5
  const lightX = 0.22 + ((h >> 4) % 3) * 0.18; // 光源横向位置 3 档
  const bgTop = `color-mix(in srgb, ${color} ${60 + shift}%, #ffffff)`;
  const bgBottom = `color-mix(in srgb, ${color} 96%, #14243a)`;
  const arcTone = `color-mix(in srgb, #ffffff 16%, transparent)`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      <defs>
        <linearGradient id={`bg${uid}`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" style={{ stopColor: bgTop }} />
          <stop offset="1" style={{ stopColor: bgBottom }} />
        </linearGradient>
        <radialGradient id={`gl${uid}`} cx={lightX} cy="0.14" r="0.95">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.38" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.07" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`cp${uid}`}>
          <rect x="0" y="0" width="64" height="64" rx="17" />
        </clipPath>
      </defs>
      <g clipPath={`url(#cp${uid})`}>
        <rect x="0" y="0" width="64" height="64" fill={`url(#bg${uid})`} />
        {/* 装饰弧线：右下角同心圆弧，印章刻纹感 */}
        <circle cx="55" cy="57" r="26" fill="none" stroke={arcTone} strokeWidth="1.6" />
        <circle cx="55" cy="57" r="34" fill="none" stroke={arcTone} strokeWidth="1.2" />
        {/* 左上柔光 */}
        <rect x="0" y="0" width="64" height="64" fill={`url(#gl${uid})`} />
        {/* 姓氏大字：微投影 + 主字 */}
        <text
          x="32"
          y="34.6"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif"
          fontSize="30"
          fontWeight="600"
          fill="#12233a"
          opacity="0.22"
        >
          {glyph}
        </text>
        <text
          x="32"
          y="33"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif"
          fontSize="30"
          fontWeight="600"
          fill="#ffffff"
        >
          {glyph}
        </text>
        {/* 内描边收边 */}
        <rect
          x="0.6"
          y="0.6"
          width="62.8"
          height="62.8"
          rx="16.4"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.4"
          strokeWidth="1.2"
        />
      </g>
    </svg>
  );
}
