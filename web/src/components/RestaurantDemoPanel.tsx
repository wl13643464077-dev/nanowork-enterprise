// PRD v2.2 FR-9：演示模式。A1–A8 各 2 条固定话术，只填店名/城市/商圈/品类即可一键派活。
// 每条话术可查看“样例结果”（一次真实实跑的存档，明确标“样例”和日期），仅作现场网络或
// 供应商故障时的兜底；始终保留“现在实跑”。
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Drawer, Empty, Input, Modal, Space, Tag, Tooltip, Typography, message } from 'antd';
import { api } from '../api/client';
import { Markdown } from './Markdown';

type DemoScript = {
  id: string;
  tierCode: string;
  employee: number | string;
  employeeIdx: number | null;
  domain: 'restaurant' | 'content';
  person: string;
  title: string;
  type: string;
  typeLabel: string;
  filled: string;
  unfilledSlots: string[];
  youGet: string;
  requiresData: boolean;
  sample: { taskId: number; capturedAt: string; taskTitle: string } | null;
};

type DemoView = { fields: string[]; defaults: Record<string, string>; items: DemoScript[] };

type Sample = { label: string; markdown: string; capturedAt: string; taskTitle: string };

type Props = {
  open: boolean;
  onClose: () => void;
  onRun: (employeeIdx: number, directive: string) => void;
};

export default function RestaurantDemoPanel({ open, onClose, onRun }: Props) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [view, setView] = useState<DemoView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sample, setSample] = useState<Sample | null>(null);

  const load = useCallback(async (values: Record<string, string>) => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams(Object.entries(values).filter(([, value]) => value && value.trim()));
      const payload = (await api.get(
        `/employee-workbench/restaurant-demo/scripts${query.toString() ? `?${query}` : ''}`,
        {
          silent: true,
        },
      )) as DemoView;
      setView(payload);
    } catch (err: any) {
      setError(err?.message || '演示话术读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const openSample = async (script: DemoScript) => {
    try {
      const payload = (await api.get(`/employee-workbench/restaurant-demo/samples/${encodeURIComponent(script.id)}`, {
        silent: true,
      })) as Sample;
      setSample(payload);
    } catch (err: any) {
      message.error(err?.message || '样例读取失败');
    }
  };

  const groups = new Map<string, DemoScript[]>();
  for (const item of view?.items || []) {
    const key = `${item.tierCode}·${item.person}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }

  return (
    <Drawer
      open={open}
      afterOpenChange={visible => {
        if (visible) void load(fields);
      }}
      onClose={onClose}
      width={720}
      title="演示模式：8 位 A 级员工 · 每位 2 条话术"
      destroyOnClose={false}
    >
      <div className="demo-panel-fields">
        <Typography.Text type="secondary">
          填好客户的店名、城市、商圈、品类，话术自动替换（默认取“我的版本”）：
        </Typography.Text>
        <Space wrap style={{ marginTop: 8 }}>
          {(view?.fields || ['店名', '城市', '商圈', '品类']).map(key => (
            <Input
              key={key}
              size="small"
              style={{ width: 130 }}
              maxLength={40}
              addonBefore={key}
              placeholder={view?.defaults?.[key] || ''}
              value={fields[key] || ''}
              onChange={event => setFields(current => ({ ...current, [key]: event.target.value }))}
            />
          ))}
          <Button size="small" type="primary" loading={loading} onClick={() => void load(fields)}>
            替换话术
          </Button>
        </Space>
      </div>
      {error && <Alert type="warning" showIcon message={error} style={{ marginTop: 12 }} />}
      {!loading && view && !view.items.length && <Empty description="没有演示话术" />}
      <div className="demo-panel-list">
        {[...groups.entries()].map(([group, scripts]) => (
          <section key={group} className="demo-panel-group">
            <h4>
              {group} <small>{scripts[0]?.title}</small>
            </h4>
            {scripts.map(script => (
              <div key={script.id} className="demo-panel-script">
                <div className="demo-panel-script-text">
                  <Tag>{script.typeLabel}</Tag>
                  {script.requiresData && (
                    <Tooltip title="这条话术需要客户自己的数据或照片，演示前先在数据接入里导入，或现场上传">
                      <Tag color="orange">需数据</Tag>
                    </Tooltip>
                  )}
                  <span>{script.filled}</span>
                  {script.youGet && <div className="demo-panel-youget">你会拿到：{script.youGet}</div>}
                </div>
                <Space size={6} wrap>
                  {script.domain === 'restaurant' && script.employeeIdx ? (
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => onRun(script.employeeIdx as number, script.filled)}
                    >
                      现在实跑
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(script.filled);
                          message.success('话术已复制，到内容工厂找种草员粘贴派活');
                        } catch {
                          message.info(script.filled);
                        }
                      }}
                    >
                      复制话术
                    </Button>
                  )}
                  <Button size="small" disabled={!script.sample} onClick={() => void openSample(script)}>
                    {script.sample ? `看样例（${String(script.sample.capturedAt || '').slice(0, 10)}）` : '暂无样例'}
                  </Button>
                </Space>
              </div>
            ))}
          </section>
        ))}
      </div>
      <Modal
        open={!!sample}
        onCancel={() => setSample(null)}
        footer={null}
        width={860}
        title={sample?.label || '样例结果'}
      >
        {sample && (
          <>
            <Alert
              type="warning"
              showIcon
              message="这是之前一次真实实跑的样例存档，不是本次实时生成；现场网络恢复后请点“现在实跑”。"
              style={{ marginBottom: 12 }}
            />
            <Markdown content={sample.markdown} />
          </>
        )}
      </Modal>
    </Drawer>
  );
}

/** 工作台结果区：把这一单真实结果存为某条演示话术的样例（仅老板/管理员，且该员工有演示话术）。 */
export function DemoSampleSaver({ employeeIdx, taskId }: { employeeIdx: number; taskId: number }) {
  const [scripts, setScripts] = useState<DemoScript[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get('/employee-workbench/restaurant-demo/scripts', { silent: true })
      .then((payload: any) => {
        if (!alive) return;
        const items = Array.isArray(payload?.items) ? (payload.items as DemoScript[]) : [];
        setScripts(items.filter(item => item.employeeIdx === employeeIdx));
      })
      .catch(() => alive && setScripts([]));
    return () => {
      alive = false;
    };
  }, [employeeIdx]);

  if (!scripts?.length) return null;
  return (
    <div className="ewb-demo-sample-saver">
      <span>存为演示样例：</span>
      {scripts.map(script => (
        <Tooltip key={script.id} title={script.filled}>
          <Button
            size="small"
            loading={saving === script.id}
            onClick={async () => {
              setSaving(script.id);
              try {
                await api.put(`/employee-workbench/restaurant-demo/samples/${encodeURIComponent(script.id)}`, {
                  taskId,
                });
                message.success('已存为样例（标注实跑日期，现场故障时兜底展示）');
              } catch (err: any) {
                message.error(err?.message || '保存失败');
              } finally {
                setSaving(null);
              }
            }}
          >
            {script.typeLabel}·{script.id.split('-').pop()}
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}
