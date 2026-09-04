import { useEffect, useMemo, useState } from 'react';
import { Select, Tooltip } from 'antd';
import { ShopOutlined } from '@ant-design/icons';
import {
  getCurrentStoreId,
  onStoreChanged,
  reconcileStoreSelection,
  setCurrentStoreId,
  type StoreOption,
} from '../api/store-context';
import './StoreSwitcher.css';

// 顶栏门店切换器（连锁客户）。只有租户门店数 > 1 才渲染；单店客户完全看不到。
// 选「全部门店」= 不带 X-Store-Id（总部合计视角）；选某店 = 该店视角，所有页面据 store-changed 事件刷新。
export default function StoreSwitcher({
  stores,
  bound,
}: {
  stores: StoreOption[];
  // 当前账号绑定的门店（店长/员工）：服务端已强制只看本店，切换器展示为锁定态
  bound?: number | null;
}) {
  const [value, setValue] = useState<number | null>(() => getCurrentStoreId());
  useEffect(() => onStoreChanged(setValue), []);
  useEffect(() => {
    if (stores.length) reconcileStoreSelection(stores);
  }, [stores]);

  const options = useMemo(
    () => [
      { value: 0, label: '全部门店' },
      ...stores.map(s => ({
        value: s.id,
        label: s.isDefault ? `${s.name}（默认）` : s.code ? `${s.name} · ${s.code}` : s.name,
      })),
    ],
    [stores],
  );

  if (stores.length <= 1) return null;

  if (bound) {
    const own = stores.find(s => s.id === bound);
    return (
      <Tooltip title="当前账号只负责这家门店，数据已按本店展示">
        <span className="store-switcher store-switcher--locked" aria-label={`当前门店：${own?.name || '本店'}`}>
          <ShopOutlined />
          <span className="store-switcher-name">{own?.name || '本店'}</span>
        </span>
      </Tooltip>
    );
  }

  return (
    <span className="store-switcher">
      <ShopOutlined className="store-switcher-icon" />
      <Select
        size="small"
        variant="borderless"
        className="store-switcher-select"
        aria-label="切换门店视角"
        value={value ?? 0}
        options={options}
        onChange={next => setCurrentStoreId(next ? Number(next) : null)}
        popupMatchSelectWidth={false}
      />
    </span>
  );
}
