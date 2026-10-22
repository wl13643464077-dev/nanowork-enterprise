import { useEffect, useMemo, useState } from 'react';
import './CampaignMaterialsGallery.css';

type CampaignMaterial = {
  id: string;
  title: string;
  kind?: string;
  variant?: string;
  groupTitle?: string;
  status?: string;
  note?: string;
  url?: string;
};

type MaterialGroup = {
  key: string;
  title: string;
  items: CampaignMaterial[];
};

export function parseCampaignMaterials(raw: unknown): CampaignMaterial[] {
  if (Array.isArray(raw)) {
    return raw.filter(item => item && typeof item === 'object' && item.id && item.title) as CampaignMaterial[];
  }
  const source = typeof raw === 'string' ? raw : '';
  const match = source.match(/```nanowork-campaign-materials\s*\n([\s\S]*?)```/u);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed?.items) ? parseCampaignMaterials(parsed.items) : [];
  } catch {
    return [];
  }
}

function groupCampaignMaterials(items: CampaignMaterial[]): MaterialGroup[] {
  const groups: MaterialGroup[] = [];
  const index = new Map<string, MaterialGroup>();
  for (const item of items) {
    const key = item.kind || item.groupTitle || item.id;
    const existing = index.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const group = { key, title: item.groupTitle || item.title.replace(/ · 方案[ABC]$/u, ''), items: [item] };
    index.set(key, group);
    groups.push(group);
  }
  return groups;
}

async function trialImageUrl(path: string, token?: string) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: token ? { 'X-Trial-Token': token } : {},
  });
  if (!response.ok) throw new Error('物料图暂时无法打开');
  const blob = await response.blob();
  if (!String(blob.type || '').startsWith('image/')) throw new Error('物料图暂时无法打开');
  return URL.createObjectURL(blob);
}

async function sessionImageUrl(path: string) {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('物料图暂时无法打开');
  const blob = await response.blob();
  if (!String(blob.type || '').startsWith('image/')) throw new Error('物料图暂时无法打开');
  return URL.createObjectURL(blob);
}

function MaterialCard({
  item,
  src,
  downloadUrl,
  selectable,
  selected,
  onSelect,
}: {
  item: CampaignMaterial;
  src?: string;
  downloadUrl?: string;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const ok = item.status === 'succeeded' && src;
  const className = [
    'campaign-material-card',
    ok ? '' : 'is-failed',
    selected ? 'is-picked' : '',
  ].filter(Boolean).join(' ');
  return (
    <figure className={className} data-slot={item.id} data-kind={item.kind || item.id}>
      {selectable ? (
        <button type="button" className="campaign-material-pick" onClick={onSelect} aria-pressed={selected}>
          {ok ? <img src={src} alt={item.title} /> : <div className="campaign-material-empty">未生成</div>}
          <span className="campaign-material-badge">{selected ? '已选这套' : '点选这套'}</span>
        </button>
      ) : ok ? (
        <img src={src} alt={item.title} />
      ) : (
        <div className="campaign-material-empty">未生成</div>
      )}
      <figcaption>
        <strong>{item.title}</strong>
        <span>{ok ? item.note || '可下载使用' : item.note || '本轮未生成'}</span>
        {ok && downloadUrl ? (
          <a href={downloadUrl} download={`${item.title}.png`}>
            {selected || !selectable ? '下载这张' : '下载备选'}
          </a>
        ) : null}
      </figcaption>
    </figure>
  );
}

export default function CampaignMaterialsGallery({
  items,
  invitationToken,
  accessToken,
  conversationId,
}: {
  items?: CampaignMaterial[];
  invitationToken?: string;
  accessToken?: string;
  conversationId?: number;
}) {
  const list = Array.isArray(items) ? items : [];
  const itemKey = list.map(item => `${item.id}:${item.status}`).join('|');
  const groups = useMemo(() => groupCampaignMaterials(list), [itemKey]);
  const [resolvedSrc, setResolvedSrc] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  const trialAuth = Boolean(invitationToken && accessToken && conversationId);
  useEffect(() => {
    const created: string[] = [];
    let active = true;
    setResolvedSrc({});
    Promise.all(
      list
        .filter(item => item.status === 'succeeded')
        .map(async item => {
          try {
            const src = trialAuth
              ? await trialImageUrl(
                  `/trial/${encodeURIComponent(invitationToken || '')}/conversations/${conversationId}/materials/${encodeURIComponent(item.id)}`,
                  accessToken,
                )
              : item.url?.startsWith('/uploads/')
                ? await sessionImageUrl(item.url)
                : '';
            if (!src) return;
            created.push(src);
            if (active) setResolvedSrc(current => ({ ...current, [item.id]: src }));
          } catch {
            /* keep the /uploads fallback on the img tag */
          }
        }),
    ).catch(() => {});
    return () => {
      active = false;
      created.forEach(url => URL.revokeObjectURL(url));
    };
  }, [trialAuth, invitationToken, accessToken, conversationId, itemKey]);
  useEffect(() => {
    setPicked(current => {
      const next = { ...current };
      for (const group of groups) {
        if (next[group.key] && group.items.some(item => item.id === next[group.key])) continue;
        const firstOk = group.items.find(item => item.status === 'succeeded') || group.items[0];
        if (firstOk) next[group.key] = firstOk.id;
      }
      return next;
    });
  }, [itemKey]);
  if (!list.length) return null;
  return (
    <section className="campaign-materials" aria-label="活动物料成图">
      <div className="campaign-materials-head">
        <strong>活动物料成图</strong>
        <span>同一套品牌视觉。宣传单、Banner 各给两套备选，点选一套带走。先读品牌 Logo 和调性再图生图，融进店名和活动，不会后期硬贴系统字。</span>
      </div>
      {groups.map(group => {
        const selectable = group.items.length > 1;
        return (
          <div key={group.key} className="campaign-material-group">
            <div className="campaign-material-group-head">
              <strong>{group.title}</strong>
              <span>{selectable ? '两套备选，点选一套使用' : '可直接下载使用'}</span>
            </div>
            <div className={`campaign-materials-grid${group.key === 'banner' ? ' is-wide' : ''}`}>
              {group.items.map(item => {
                const sessionUrl = item.url?.startsWith('/uploads/') ? item.url : undefined;
                const src = resolvedSrc[item.id] || (trialAuth ? undefined : sessionUrl);
                const downloadUrl = resolvedSrc[item.id] || (trialAuth ? undefined : sessionUrl);
                return (
                  <MaterialCard
                    key={item.id}
                    item={item}
                    src={src}
                    downloadUrl={downloadUrl}
                    selectable={selectable}
                    selected={picked[group.key] === item.id}
                    onSelect={() => setPicked(current => ({ ...current, [group.key]: item.id }))}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
