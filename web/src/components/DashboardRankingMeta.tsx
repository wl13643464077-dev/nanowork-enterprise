import { CrownFilled, FireFilled, StarFilled, TrophyFilled } from '@ant-design/icons';

export function dashboardRankMeta(rank: number) {
  if (rank === 1) {
    return {
      icon: <CrownFilled />,
      label: '冠军',
      color: '#b7791f',
      bg: 'linear-gradient(135deg,var(--ui-surface),var(--ui-surface))',
      border: '#f5c542',
    };
  }
  if (rank === 2) {
    return {
      icon: <TrophyFilled />,
      label: '亚军',
      color: '#64748b',
      bg: 'linear-gradient(135deg,var(--ui-surface),var(--ui-surface))',
      border: 'var(--ui-surface)',
    };
  }
  if (rank === 3) {
    return {
      icon: <StarFilled />,
      label: '季军',
      color: '#e0a253',
      bg: 'linear-gradient(135deg,var(--ui-surface),var(--ui-surface))',
      border: '#fdba74',
    };
  }
  return {
    icon: <FireFilled />,
    label: `第${rank}名`,
    color: 'var(--ui-accent)',
    bg: 'var(--ui-surface)',
    border: 'var(--ui-border-strong)',
  };
}
