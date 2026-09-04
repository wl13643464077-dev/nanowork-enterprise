import { useEffect, useState } from 'react';
import { Button, Empty, Spin, Tag, message } from 'antd';
import { DownloadOutlined, ShopOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import './DataIntakeTemplates.css';

// 多门店批量导入模板（连锁过渡方案：门店人工上传 Excel，不接美团接口）。
// 模板由服务端 exceljs 生成：含填写说明、示例行、本企业门店名下拉与枚举下拉。

export interface ImportTemplateColumn {
  key: string;
  header: string;
  required: boolean;
  note: string;
  options: string[] | 'stores' | null;
}

export interface ImportTemplate {
  key: string;
  target: string;
  label: string;
  sheet: string;
  description: string;
  storeColumn: boolean;
  columns: ImportTemplateColumn[];
  downloadPath: string;
}

export interface TenantStoreRef {
  id: number;
  name: string;
  code: string | null;
  isDefault: boolean;
}

export async function downloadImportTemplate(template: ImportTemplate) {
  const response = await fetch(template.downloadPath, { credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `模板下载失败（${response.status}）`);
  }
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `纳米Work_${template.label}_导入模板.xlsx`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function DataIntakeTemplates({ compact = false }: { compact?: boolean }) {
  const [templates, setTemplates] = useState<ImportTemplate[] | null>(null);
  const [stores, setStores] = useState<TenantStoreRef[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/data-intake/templates', { silent: true })
      .then(payload => {
        if (cancelled) return;
        setTemplates(Array.isArray(payload?.templates) ? payload.templates : []);
        setStores(Array.isArray(payload?.stores) ? payload.stores : []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const download = async (template: ImportTemplate) => {
    setDownloading(template.key);
    try {
      await downloadImportTemplate(template);
      message.success(
        `已下载「${template.label}」模板${template.storeColumn && stores.length ? `，门店下拉含 ${stores.length} 家门店` : ''}`,
      );
    } catch (error: any) {
      message.error(error?.message || '模板下载失败');
    } finally {
      setDownloading(null);
    }
  };

  if (templates === null) return <Spin />;
  if (!templates.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可下载模板" />;

  return (
    <div className="di-templates">
      <div className="di-templates-intro">
        连锁多门店按这些模板整理数据后直接拖到上方即可导入。所有表统一用「门店名称/门店编码」标门店，
        {stores.length ? (
          <>
            模板里的门店下拉已按你企业现有 <strong>{stores.length}</strong> 家门店生成
            {stores.some(store => store.code) ? '（填门店编码也能识别）' : ''}。
          </>
        ) : (
          <>你的企业还没有门店档案，建议先下载并导入「门店清单」。</>
        )}
        同店同日 / 同店同月同类别的数据重复导入会<strong>覆盖</strong>而不是重复累计。
      </div>
      <div className="di-templates-grid">
        {templates.map(template => (
          <div className="di-template-card" key={template.key}>
            <div className="di-template-title">
              <span>{template.label}</span>
              {template.storeColumn ? (
                <Tag icon={<ShopOutlined />} color="blue">
                  按店
                </Tag>
              ) : null}
            </div>
            {!compact ? <div className="di-template-desc">{template.description}</div> : null}
            <div className="di-template-columns">
              {template.columns.map(column => (
                <Tag key={column.key} color={column.required ? 'orange' : undefined}>
                  {column.header}
                  {column.required ? ' *' : ''}
                </Tag>
              ))}
            </div>
            <div className="di-template-actions">
              <Button
                type="primary"
                ghost
                icon={<DownloadOutlined />}
                loading={downloading === template.key}
                onClick={() => void download(template)}
              >
                下载模板
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===== 预览阶段的门店问题处理：未匹配门店必须显式选择「新建门店」或「改为默认店」 =====
export interface BatchStoreIssues {
  unmatched: { name: string; rows: number }[];
  defaultedRows: number;
  defaultStoreName: string;
}

export function StoreIssuesBar({
  issues,
  busy,
  onCreateStores,
  onUseDefault,
}: {
  issues: BatchStoreIssues | undefined;
  busy?: boolean;
  onCreateStores: (names: string[]) => void | Promise<void>;
  onUseDefault: (names: string[]) => void | Promise<void>;
}) {
  if (!issues) return null;
  const unmatched = issues.unmatched || [];
  if (!unmatched.length && !issues.defaultedRows) return null;
  return (
    <div className="di-store-issues" role="status">
      {unmatched.length ? (
        <>
          <div>
            有 {unmatched.length} 个门店名在系统里找不到，这些行暂不会写入。请选择：新建门店，或把它们归到默认店「
            {issues.defaultStoreName || '未设置'}」。
          </div>
          {unmatched.map(item => (
            <div className="di-store-issue-row" key={item.name}>
              <span>
                <span className="di-store-issue-name">{item.name}</span>
                <span className="di-store-defaulted">（{item.rows} 行）</span>
              </span>
              <span className="di-store-issue-actions">
                <Button size="small" type="primary" loading={busy} onClick={() => void onCreateStores([item.name])}>
                  新建门店
                </Button>
                <Button
                  size="small"
                  loading={busy}
                  disabled={!issues.defaultStoreName}
                  onClick={() => void onUseDefault([item.name])}
                >
                  改为默认店
                </Button>
              </span>
            </div>
          ))}
          {unmatched.length > 1 ? (
            <div className="di-store-issue-actions">
              <Button size="small" loading={busy} onClick={() => void onCreateStores(unmatched.map(item => item.name))}>
                全部新建门店
              </Button>
              <Button
                size="small"
                loading={busy}
                disabled={!issues.defaultStoreName}
                onClick={() => void onUseDefault(unmatched.map(item => item.name))}
              >
                全部改为默认店
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {issues.defaultedRows ? (
        <div className="di-store-defaulted">
          {issues.defaultedRows} 行没填门店，将归入
          {issues.defaultStoreName ? `「${issues.defaultStoreName}」` : '默认店（写入时自动创建）'}。
        </div>
      ) : null}
    </div>
  );
}

export default DataIntakeTemplates;
