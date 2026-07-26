// 数字员工插画头像：Notion 风组件化 SVG，按员工 idx 确定性生成（零外部素材）。
// 设计约束（对标 2026 数字员工呈现调研结论）：
// - 统一线宽 2px / 统一 64 网格 / 低饱和色板 → 60 个头像呈现"一套设计系统"的质感
// - 部件化：脸型固定 + 发型 × 配饰（厨师帽/耳麦/眼镜/贝雷帽）× 领口（围裙/衬衫）组合
// - 配饰按分部映射（研发戴厨师帽、运营戴耳麦、财务戴眼镜…），岗位一眼可辨
// - 禁止追求真人感（恐怖谷 + 廉价双输），扁平插画是感染力与专业感的最优折中

const INK = '#3b4a5c';
const SKIN = ['#f6dcc8', '#f1cfb4', '#e9c0a2'];
const HAIR = ['#37455a', '#5b4232', '#7a5540', '#8d939c'];

function hashOf(seed: number) {
  let h = (seed * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = (h * 2246822519) >>> 0;
  h ^= h >>> 13;
  return h;
}

// 分部 → 职业配饰
function accessoryFor(group: string, h: number): 'chef' | 'headset' | 'glasses' | 'beret' | 'none' {
  const g = group || '';
  if (/菜单|研发|食安|供应链|库存/.test(g)) return 'chef';
  if (/运营|门店/.test(g)) return 'headset';
  if (/财务|数据/.test(g)) return 'glasses';
  if (/品牌|增长|营销/.test(g)) return 'beret';
  return h % 3 === 0 ? 'glasses' : 'none';
}

export default function EmployeeAvatar({ idx, color = '#2c76dc', group = '', size = 56 }: {
  idx: number; color?: string; group?: string; size?: number;
}) {
  const h = hashOf(idx);
  const skin = SKIN[h % SKIN.length];
  const hairColor = HAIR[(h >> 3) % HAIR.length];
  const accessory = accessoryFor(group, h);
  // 戴厨师帽/贝雷帽时不再叠发型；其余从 5 款发型确定性选择
  const hairStyle = accessory === 'chef' || accessory === 'beret' ? -1 : (h >> 6) % 5;
  const apron = (h >> 9) % 2 === 0;
  const stroke = { stroke: INK, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ display: 'block', flex: '0 0 auto' }}>
      {/* 底色：员工色的低饱和浅底 */}
      <rect x="0" y="0" width="64" height="64" rx="16" style={{ fill: `color-mix(in srgb, ${color} 16%, #fdfefe)` }} />
      {/* 肩部/上衣 */}
      <path d="M13 64 C13 51 21 46 32 46 C43 46 51 51 51 64 Z"
        style={{ fill: `color-mix(in srgb, ${color} 52%, #ffffff)` }} {...stroke} />
      {apron ? (
        <>
          {/* 围裙：领带 + 前片 */}
          <path d="M26 48 L26 64 M38 48 L38 64" fill="none" {...stroke} />
          <path d="M26 55 L38 55" fill="none" {...stroke} strokeWidth={1.4} />
        </>
      ) : (
        <path d="M28 47 L32 52 L36 47" fill="none" {...stroke} />
      )}
      {/* 头部 */}
      <ellipse cx="32" cy="29" rx="11.5" ry="12.5" fill={skin} {...stroke} />
      {/* 耳朵 */}
      <circle cx="20.5" cy="30" r="2.4" fill={skin} {...stroke} strokeWidth={1.6} />
      <circle cx="43.5" cy="30" r="2.4" fill={skin} {...stroke} strokeWidth={1.6} />
      {/* 发型（-1 = 被帽子取代） */}
      {hairStyle === 0 && /* 三七分短发 */
        <path d="M20.5 29 C20.5 18.5 26 16.5 32 16.5 C38 16.5 43.5 18.5 43.5 29 C43.5 24 41 21.5 36.5 21 C30 20.5 24 22 20.5 29 Z" fill={hairColor} {...stroke} />}
      {hairStyle === 1 && /* 齐刘海波波头 */
        <path d="M19.5 34 C19 18 26 15.5 32 15.5 C38 15.5 45 18 44.5 34 L42.5 34 C43.5 26 42 22.5 40 22 C36 21 28 21 24 22 C22 22.5 20.5 26 21.5 34 Z" fill={hairColor} {...stroke} />}
      {hairStyle === 2 && /* 丸子头 */
        <>
          <circle cx="32" cy="14.5" r="4.5" fill={hairColor} {...stroke} />
          <path d="M20.5 29 C20.5 19 26 17 32 17 C38 17 43.5 19 43.5 29 C43.5 23.5 40 21.5 32 21.5 C24 21.5 20.5 23.5 20.5 29 Z" fill={hairColor} {...stroke} />
        </>}
      {hairStyle === 3 && /* 卷发云朵 */
        <path d="M20 28 C17.5 22 21 16.5 26 17 C27 13.5 37 13.5 38 17 C43 16.5 46.5 22 44 28 C42.5 23 39.5 21 32 21 C24.5 21 21.5 23 20 28 Z" fill={hairColor} {...stroke} />}
      {hairStyle === 4 && /* 利落寸头 */
        <path d="M21 26.5 C22 19 26.5 16.5 32 16.5 C37.5 16.5 42 19 43 26.5 C39.5 22.5 36 21.5 32 21.5 C28 21.5 24.5 22.5 21 26.5 Z" fill={hairColor} {...stroke} />}
      {/* 职业配饰 */}
      {accessory === 'chef' && (
        <>
          <path d="M21.5 21.5 C18 14 24 9.5 28 12 C29 8.5 35 8.5 36 12 C40 9.5 46 14 42.5 21.5 Z" fill="#ffffff" {...stroke} />
          <path d="M21.5 21.5 L42.5 21.5 L42.5 25 L21.5 25 Z" fill="#ffffff" {...stroke} />
        </>
      )}
      {accessory === 'beret' && (
        <>
          <path d="M19.5 22.5 C20 14.5 27 12 33 12.5 C40 13 45 17 44.5 22 C38 18.5 26 19 19.5 22.5 Z" style={{ fill: `color-mix(in srgb, ${color} 62%, #38465a)` }} {...stroke} />
          <circle cx="33" cy="11.5" r="1.6" fill={INK} />
        </>
      )}
      {accessory === 'headset' && (
        <>
          <path d="M20 27 C20 17 26 14.5 32 14.5 C38 14.5 44 17 44 27" fill="none" {...stroke} />
          <rect x="17.8" y="26" width="4.4" height="7" rx="2.2" fill={INK} />
          <path d="M21 33 C22 37.5 25 39.5 28.5 39.5" fill="none" {...stroke} strokeWidth={1.6} />
          <circle cx="29.5" cy="39.5" r="1.7" fill={INK} />
        </>
      )}
      {accessory === 'glasses' && (
        <>
          <circle cx="26.5" cy="30" r="4.2" fill="none" {...stroke} strokeWidth={1.7} />
          <circle cx="37.5" cy="30" r="4.2" fill="none" {...stroke} strokeWidth={1.7} />
          <path d="M30.7 30 L33.3 30" fill="none" {...stroke} strokeWidth={1.7} />
        </>
      )}
      {/* 眉眼：戴眼镜时眼睛画在镜片内 */}
      <circle cx="26.5" cy={accessory === 'glasses' ? 30.4 : 29.5} r="1.5" fill={INK} />
      <circle cx="37.5" cy={accessory === 'glasses' ? 30.4 : 29.5} r="1.5" fill={INK} />
      {accessory !== 'glasses' && (
        <>
          <path d="M24.4 26 Q26.5 24.8 28.6 26" fill="none" {...stroke} strokeWidth={1.4} />
          <path d="M35.4 26 Q37.5 24.8 39.6 26" fill="none" {...stroke} strokeWidth={1.4} />
        </>
      )}
      {/* 微笑 + 腮红 */}
      <path d="M28.2 35.2 Q32 38.4 35.8 35.2" fill="none" {...stroke} />
      <circle cx="23.6" cy="34" r="1.7" fill="#f1a48c" opacity="0.5" />
      <circle cx="40.4" cy="34" r="1.7" fill="#f1a48c" opacity="0.5" />
    </svg>
  );
}
