import { useId, useState } from 'react';

import './EmployeeAvatar.css';

// 数字员工头像 v4：真实职业肖像（云雾 gpt-image-2 生成，按部门定制着装/气质）+ 印章徽章降级。
// 迭代记录：v1 参数化五官插画 → 观感粗糙；v2 白色人形剪影 → 像"未上传头像"占位图；
// v3 姓氏印章徽章（Linear/Notion 字母头像的中文形态）；
// v4 在 v3 之上叠加真实肖像：/avatars/employees/emp-XX.jpg 存在则展示照片，
// 加载失败（未生成/被删）自动降级 v3 印章，保证任何环境下都不出现破图。

function hashOf(seed: number) {
  let h = (seed * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = (h * 2246822519) >>> 0;
  h ^= h >>> 13;
  return h;
}

// 餐饮员工 idx 101-161 → emp-01..61；内容员工工位 0-10 → crew-00..10。
// idx10 是纳米Work原生 AI 带货员，也使用专属职业肖像，不再降级为通用占位头像。
export function employeePortraitUrl(idx: number): string | null {
  if (idx >= 101 && idx <= 161) return `/avatars/employees/emp-${String(idx - 100).padStart(2, '0')}.jpg`;
  if (idx >= 0 && idx <= 10) return `/avatars/employees/crew-${String(idx).padStart(2, '0')}.jpg`;
  return null;
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
  const [photoFailed, setPhotoFailed] = useState(false);
  const portrait = employeePortraitUrl(idx);
  if (portrait && !photoFailed) {
    // 部门色调证件照体系：静态规则在 EmployeeAvatar.css；这里只注入
    // 动态尺寸与部门色变量。
    return (
      <span
        aria-hidden="true"
        className="emp-avatar"
        style={
          {
            width: size,
            height: size,
            borderRadius: Math.round(size * 0.27),
            '--avatar-color': color,
          } as import('react').CSSProperties
        }
      >
        <img src={portrait} alt="" width={size} height={size} loading="lazy" onError={() => setPhotoFailed(true)} />
        <i />
      </span>
    );
  }
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
