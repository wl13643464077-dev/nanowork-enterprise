import { useEffect, useState } from 'react';
import { Form, Input, Select } from 'antd';
import { api } from '../api/client';
import type { StoreOption } from '../api/store-context';

// 管理后台用户表单的「组织归属」字段：部门 + 所属门店（连锁客户）。
// - 门店清单来自 /auth/me → tenant.stores（管理后台账号无需 analysis 模块即可读到）。
// - 所属门店留空 = 总部/全店：老板、管理员和门店运营通常留空；店长/员工绑定后只看本店、写入默认落本店。
// - 单店客户（≤1 家门店）只渲染部门输入框，表单与以前完全一样。
export default function UserOrgFields({ storeField = 'storeId' }: { storeField?: string }) {
  const [stores, setStores] = useState<StoreOption[]>([]);
  useEffect(() => {
    api
      .get('/auth/me', { silent: true })
      .then((me: any) => setStores(Array.isArray(me?.tenant?.stores) ? me.tenant.stores : []))
      .catch(() => setStores([]));
  }, []);
  return (
    <>
      <Form.Item name="dept" label="部门">
        <Input placeholder="如：销售部" />
      </Form.Item>
      {stores.length > 1 && (
        <Form.Item
          name={storeField}
          label="所属门店"
          tooltip="留空表示总部/全店视角；店长、一线员工绑定门店后只看本店数据，排班打卡等默认落到本店"
        >
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="总部 / 全店（不绑定）"
            options={stores.map(s => ({
              value: s.id,
              label: s.isDefault ? `${s.name}（默认店）` : s.code ? `${s.name} · ${s.code}` : s.name,
            }))}
          />
        </Form.Item>
      )}
    </>
  );
}
