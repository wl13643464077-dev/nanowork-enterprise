import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Select, Tag, message } from 'antd';
import {
  CameraOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  PictureOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { api, notifyCredits } from '../api/client';
import { StoreIssuesBar, type BatchStoreIssues } from './DataIntakeTemplates';
import './DataIntakeTemplates.css';

// 拍照/截图导入：收银日结单、外卖后台截图、菜单照片、进货单/发票 → vision 严格 JSON → 逐行确认 → 走现有提交链路。
// 组件 props 驱动、不依赖 System 页面上下文，可直接挂到移动端 /m。

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.pdf';

export type VisionKind = 'auto' | 'daily_summary' | 'menu' | 'cost_receipt' | 'delivery_report';

const KIND_OPTIONS: { value: VisionKind; label: string }[] = [
  { value: 'auto', label: '自动判断（日结单 / 菜单 / 票据 / 外卖后台）' },
  { value: 'daily_summary', label: '收银日结单 / 每日营业汇总' },
  { value: 'delivery_report', label: '外卖平台后台截图' },
  { value: 'menu', label: '菜单照片' },
  { value: 'cost_receipt', label: '进货单 / 发票 / 成本票据' },
];

interface PickedFile {
  id: number;
  name: string;
  ext?: string;
  file_url?: string;
}

interface PreviewRow {
  rowNumber: number;
  data: Record<string, unknown>;
  valid: boolean;
  error?: string;
  sample?: boolean;
  fieldConfidence?: Record<string, number>;
  lowConfidenceFields?: string[];
  unreadableFields?: string[];
  store?: { id: number | null; name: string; unresolved: boolean; defaulted: boolean };
}

interface PreviewBatch {
  sheet: string;
  target: string;
  targetLabel: string;
  headers: string[];
  mapping: (string | null)[];
  rows: PreviewRow[];
  validRows: number;
  invalidRows: number;
  stores?: BatchStoreIssues;
  source?: {
    type: string;
    kind: string;
    fileId: number | null;
    fileName: string;
    fileUrl: string | null;
    confidence: number;
  };
  fileId?: number;
  lowConfidenceThreshold?: number;
}

interface FileResult {
  fileId: number;
  name: string;
  status: 'ok' | 'cached' | 'failed';
  kindLabel?: string;
  rows?: number;
  confidence?: number;
  error?: string;
  billing?: { state?: string; chargedCredits?: number | null; balance?: number | null } | null;
}

interface EditableBatch extends PreviewBatch {
  localKey: string;
  touched: Record<number, Set<string>>;
}

function fileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () =>
      resolve(
        String(reader.result || '')
          .split(',')
          .pop() || '',
      );
    reader.readAsDataURL(file);
  });
}

function newImportKey() {
  return globalThis.crypto?.randomUUID?.() || `vision-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function cellText(value: unknown) {
  return value === null || value === undefined ? '' : String(value);
}

// 把编辑后的批次还原成「工作表」回传服务端重新校验（表头 + 行 + 识别元数据）
function batchToSheet(batch: EditableBatch) {
  const rows = batch.rows.map(row =>
    batch.headers.map((_, index) => {
      const field = batch.mapping[index];
      return field ? cellText(row.data[field]) : '';
    }),
  );
  const rowMeta = batch.rows.map(row => ({
    fieldConfidence: row.fieldConfidence || {},
    lowConfidenceFields: (row.lowConfidenceFields || []).filter(header => !batch.touched[row.rowNumber]?.has(header)),
    unreadableFields: (row.unreadableFields || []).filter(header => {
      const field = batch.mapping[batch.headers.indexOf(header)];
      return !field || cellText(row.data[field]) === '';
    }),
  }));
  return { name: batch.sheet, target: batch.target, rows: [batch.headers, ...rows], rowMeta, source: batch.source };
}

export function DataIntakeVisionImport({
  onCommitted,
  onBalance,
  title = '拍照 / 截图导入',
}: {
  onCommitted?: (result: any) => void;
  onBalance?: (balance: number) => void;
  title?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<VisionKind>('auto');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [estimate, setEstimate] = useState<{
    estimatedCredits: number;
    balance: number;
    available: boolean;
    model: string;
  } | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [batches, setBatches] = useState<EditableBatch[]>([]);
  const [storeOverrides, setStoreOverrides] = useState<Record<string, number | 'default'>>({});
  const [validating, setValidating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [importKey, setImportKey] = useState(newImportKey);
  const [result, setResult] = useState<any>(null);

  const fileIds = useMemo(() => files.map(file => file.id), [files]);

  useEffect(() => {
    if (!fileIds.length) return;
    let cancelled = false;
    api
      .post('/data-intake/vision-estimate', { fileIds, kind }, { silent: true })
      .then(payload => {
        if (!cancelled) setEstimate(payload);
      })
      .catch(() => {
        if (!cancelled) setEstimate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fileIds, kind]);

  const pick = async (selected: FileList | null) => {
    const list = Array.from(selected || []);
    if (!list.length) return;
    if (files.length + list.length > MAX_FILES) {
      message.warning(`单次最多识别 ${MAX_FILES} 张`);
      return;
    }
    setUploading(true);
    const next = [...files];
    try {
      for (const file of list) {
        if (file.size > MAX_FILE_BYTES) {
          message.warning(`${file.name} 超过 10MB，已跳过`);
          continue;
        }
        try {
          const b64 = await fileAsBase64(file);
          // recognize:false：这里不走文件中心的通用识图，避免同一张图计费两次；识别在「开始识别」时按结构化 schema 进行
          const uploaded = await api.post('/files/upload', {
            name: file.name,
            mime: file.type,
            b64,
            purpose: 'data-intake',
            recognize: false,
          });
          next.push({
            id: uploaded.file.id,
            name: uploaded.file.name,
            ext: uploaded.file.ext,
            file_url: uploaded.file.file_url,
          });
        } catch (error: any) {
          message.error(`${file.name} 上传失败：${error?.message || '请重试'}`);
        }
      }
      setFiles(next.slice(0, MAX_FILES));
      setBatches([]);
      setFileResults([]);
      setResult(null);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const applyPreview = useCallback((incoming: PreviewBatch[]) => {
    setBatches(previous =>
      incoming.map((batch, index) => ({
        ...batch,
        localKey: previous[index]?.localKey || `${batch.fileId || batch.sheet}-${index}`,
        touched: previous[index]?.touched || {},
      })),
    );
  }, []);

  const recognize = async () => {
    if (!files.length) return message.warning('请先选择图片或截图');
    setRecognizing(true);
    try {
      const out = await api.post('/data-intake/vision-preview', { fileIds, kind, storeOverrides });
      setFileResults(Array.isArray(out.files) ? out.files : []);
      applyPreview(Array.isArray(out.batches) ? out.batches : []);
      setImportKey(newImportKey());
      setResult(null);
      if (typeof out.billing?.balance === 'number') {
        notifyCredits(out.billing.balance);
        onBalance?.(out.billing.balance);
      }
      const failed = (out.files || []).filter((item: FileResult) => item.status === 'failed').length;
      if (failed) message.warning(`${failed} 张未识别成功，失败的不扣积分`);
      else message.success(`识别完成，请逐行核对后再写入`);
    } catch (error: any) {
      message.error(error?.message || '识别失败');
    } finally {
      setRecognizing(false);
    }
  };

  const revalidate = useCallback(
    async (overrides = storeOverrides, source = batches) => {
      if (!source.length) return [] as PreviewBatch[];
      setValidating(true);
      try {
        const out = await api.post('/data-intake/preview', {
          sheets: source.map(batchToSheet),
          storeOverrides: overrides,
        });
        const incoming: PreviewBatch[] = Array.isArray(out.batches) ? out.batches : [];
        applyPreview(
          incoming.map((batch, index) => ({ ...batch, fileId: source[index]?.fileId, source: source[index]?.source })),
        );
        return incoming;
      } finally {
        setValidating(false);
      }
    },
    [applyPreview, batches, storeOverrides],
  );

  const editCell = (batchIndex: number, rowNumber: number, header: string, value: string) => {
    setBatches(previous =>
      previous.map((batch, index) => {
        if (index !== batchIndex) return batch;
        const field = batch.mapping[batch.headers.indexOf(header)];
        if (!field) return batch;
        const touched = { ...batch.touched, [rowNumber]: new Set([...(batch.touched[rowNumber] || []), header]) };
        return {
          ...batch,
          touched,
          rows: batch.rows.map(row =>
            row.rowNumber === rowNumber ? { ...row, data: { ...row.data, [field]: value } } : row,
          ),
        };
      }),
    );
  };

  const removeRow = (batchIndex: number, rowNumber: number) => {
    setBatches(previous =>
      previous.map((batch, index) =>
        index === batchIndex ? { ...batch, rows: batch.rows.filter(row => row.rowNumber !== rowNumber) } : batch,
      ),
    );
  };

  const createStores = async (names: string[]) => {
    try {
      await api.post('/data-intake/stores', { names });
      message.success(`已新建门店：${names.join('、')}`);
      await revalidate();
    } catch (error: any) {
      message.error(error?.message || '新建门店失败');
    }
  };

  const useDefaultStore = async (names: string[]) => {
    const next = { ...storeOverrides };
    for (const name of names) next[name] = 'default';
    setStoreOverrides(next);
    await revalidate(next);
  };

  const commit = async () => {
    if (!batches.length) return;
    setCommitting(true);
    try {
      const validated = await revalidate();
      const pending = validated.reduce((sum, batch) => sum + Number(batch.invalidRows || 0), 0);
      if (pending) {
        message.warning(`还有 ${pending} 行未通过核对：黄色为低置信需确认，红色为未识别必须填写或删行`);
        return;
      }
      const total = validated.reduce((sum, batch) => sum + Number(batch.validRows || 0), 0);
      if (!total) return message.warning('没有可写入的行');
      const payload = validated.map((batch, index) => ({
        ...batch,
        fileId: batches[index]?.fileId,
        source: batches[index]?.source,
      }));
      const out = await api.post('/data-intake/commit', {
        batches: payload,
        idempotencyKey: importKey,
        storeOverrides,
      });
      setResult(out);
      window.dispatchEvent(new CustomEvent('nanowork-data-updated', { detail: out.sync || {} }));
      message.success(out.replayed ? '该批数据已写入过，本次未重复写入' : `已写入 ${out.imported} 行`);
      onCommitted?.(out);
    } catch (error: any) {
      message.error(error?.message || '写入失败');
    } finally {
      setCommitting(false);
    }
  };

  const reset = () => {
    setFiles([]);
    setBatches([]);
    setFileResults([]);
    setResult(null);
    setEstimate(null);
    setStoreOverrides({});
    setImportKey(newImportKey());
  };

  const totalRows = batches.reduce((sum, batch) => sum + batch.rows.length, 0);
  const failedFiles = fileResults.filter(item => item.status === 'failed');

  return (
    <div className="di-vision">
      <div className="di-vision-hint">
        <strong>{title}：</strong>
        把收银日结单、外卖平台后台截图、菜单照片、进货单/发票拍下来传上来，系统识别成表格，你逐行核对后再写入。
        <strong>微信里收到的日结单 / 账单截图，保存到手机后在这里上传即可</strong>，不需要接任何系统。
        识别按图片体积预估积分、按真实用量结算，识别失败不扣分。
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        aria-label="选择要识别的图片或截图"
        hidden
        onChange={event => void pick(event.target.files)}
      />
      <div className="di-vision-toolbar">
        <Button icon={<CameraOutlined />} loading={uploading} onClick={() => inputRef.current?.click()}>
          {files.length ? '再加图片' : '拍照 / 选择截图'}
        </Button>
        <Select<VisionKind>
          className="di-vision-kind"
          value={kind}
          options={KIND_OPTIONS}
          onChange={value => setKind(value)}
          aria-label="识别类型"
        />
        <Button
          type="primary"
          icon={<PictureOutlined />}
          disabled={!files.length || uploading}
          loading={recognizing}
          onClick={() => void recognize()}
        >
          开始识别{files.length ? `（${files.length} 张）` : ''}
        </Button>
        {files.length ? (
          <Button icon={<ReloadOutlined />} onClick={reset}>
            重新开始
          </Button>
        ) : null}
      </div>

      {files.length ? (
        <div className="di-vision-files">
          {files.map(file => {
            const outcome = fileResults.find(item => item.fileId === file.id);
            const isImage = /^(png|jpe?g|webp|gif)$/i.test(String(file.ext || ''));
            return (
              <div className="di-vision-file" key={file.id}>
                {isImage && file.file_url ? (
                  <img className="di-vision-thumb" src={file.file_url} alt="" />
                ) : (
                  <div className="di-vision-thumb di-vision-thumb--placeholder">
                    <PictureOutlined />
                  </div>
                )}
                <div className="di-vision-file-meta">
                  <span className="di-vision-file-name">{file.name}</span>
                  <span className="di-vision-file-status">
                    {!outcome
                      ? '待识别'
                      : outcome.status === 'failed'
                        ? `识别失败：${outcome.error || ''}${outcome.billing?.state === 'released' ? '（未扣分）' : ''}`
                        : `${outcome.kindLabel || ''} · ${outcome.rows ?? 0} 行 · 整体置信 ${Math.round((outcome.confidence || 0) * 100)}%` +
                          (outcome.status === 'cached'
                            ? ' · 沿用此前识别，不计费'
                            : ` · 实扣 ${outcome.billing?.chargedCredits ?? 0} 积分`)}
                  </span>
                </div>
                <Button
                  type="text"
                  danger
                  aria-label={`移除 ${file.name}`}
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    setFiles(current => current.filter(item => item.id !== file.id));
                    setBatches([]);
                    setFileResults([]);
                  }}
                />
              </div>
            );
          })}
        </div>
      ) : null}

      {files.length && estimate ? (
        <div className="di-vision-estimate">
          <span>
            预计最多 <strong>{estimate.estimatedCredits}</strong> 积分
          </span>
          <span>当前余额 {estimate.balance}</span>
          {!estimate.available ? <Tag color="red">识图通道未配置</Tag> : null}
          {estimate.estimatedCredits > estimate.balance ? <Tag color="red">余额可能不足</Tag> : null}
          <span className="di-store-defaulted">按真实用量多退少补；识别失败全额退回</span>
        </div>
      ) : null}

      {failedFiles.length && !batches.length ? (
        <Alert
          type="warning"
          showIcon
          message="这次没有识别出可用的数据"
          description="换一张更清晰的图片，或手动选择识别类型后重试。失败的识别不扣积分。"
        />
      ) : null}

      {batches.map((batch, batchIndex) => (
        <div className="di-vision-batch" key={batch.localKey}>
          <div className="di-vision-batch-head">
            <div className="di-vision-batch-title">
              <span>{batch.source?.fileName || batch.sheet}</span>
              <Tag color="blue">写入：{batch.targetLabel}</Tag>
              <Tag color={batch.invalidRows ? 'orange' : 'green'}>
                {batch.validRows} 行可写入{batch.invalidRows ? ` · ${batch.invalidRows} 行待处理` : ''}
              </Tag>
            </div>
            <div className="di-vision-legend">
              <span>
                <i className="di-vision-legend-swatch di-vision-legend-swatch--low" /> 低置信（请确认）
              </span>
              <span>
                <i className="di-vision-legend-swatch di-vision-legend-swatch--missing" /> 未识别（必须填写或删行）
              </span>
            </div>
          </div>
          <StoreIssuesBar
            issues={batch.stores}
            busy={validating}
            onCreateStores={createStores}
            onUseDefault={useDefaultStore}
          />
          <div className="di-vision-table-wrap">
            <table className="di-vision-table">
              <thead>
                <tr>
                  {batch.headers.map(header => (
                    <th key={header}>{header}</th>
                  ))}
                  <th>门店</th>
                  <th>核对</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {batch.rows.map(row => (
                  <tr key={row.rowNumber}>
                    {batch.headers.map((header, columnIndex) => {
                      const field = batch.mapping[columnIndex];
                      const value = field ? cellText(row.data[field]) : '';
                      const confirmed = batch.touched[row.rowNumber]?.has(header);
                      const missing = !value && (row.unreadableFields || []).includes(header);
                      const low = !confirmed && (row.lowConfidenceFields || []).includes(header);
                      const confidence = row.fieldConfidence?.[header];
                      return (
                        <td
                          key={header}
                          className={missing ? 'di-vision-cell--missing' : low ? 'di-vision-cell--low' : undefined}
                        >
                          <Input
                            size="small"
                            value={value}
                            aria-label={`第 ${row.rowNumber} 行 ${header}`}
                            placeholder={missing ? '未识别，请填写' : ''}
                            disabled={!field}
                            onChange={event => editCell(batchIndex, row.rowNumber, header, event.target.value)}
                          />
                          {typeof confidence === 'number' && !confirmed ? (
                            <span className="di-vision-cell-confidence">置信 {Math.round(confidence * 100)}%</span>
                          ) : null}
                        </td>
                      );
                    })}
                    <td>
                      {row.store ? (
                        row.store.unresolved ? (
                          <Tag color="red">未匹配</Tag>
                        ) : (
                          <Tag color={row.store.defaulted ? 'orange' : 'green'}>{row.store.name || '默认店'}</Tag>
                        )
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>
                      {row.valid ? (
                        <Tag color="green">可写入</Tag>
                      ) : (
                        <span className="di-vision-row-error">{row.error || '待处理'}</span>
                      )}
                    </td>
                    <td className="di-vision-row-actions">
                      <Button
                        type="text"
                        danger
                        aria-label={`删除第 ${row.rowNumber} 行`}
                        icon={<DeleteOutlined />}
                        onClick={() => removeRow(batchIndex, row.rowNumber)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {batches.length ? (
        <div className="di-vision-submit">
          <Button icon={<ReloadOutlined />} loading={validating} onClick={() => void revalidate()}>
            重新校验
          </Button>
          <Button
            type="primary"
            size="large"
            icon={<CheckCircleOutlined />}
            loading={committing}
            disabled={!totalRows}
            onClick={() => void commit()}
          >
            确认并写入（{totalRows} 行）
          </Button>
        </div>
      ) : null}

      {result ? (
        <Alert
          type={result.imported > 0 ? 'success' : 'warning'}
          showIcon
          message={`已写入 ${result.imported} 行`}
          description={(result.results || []).map((item: any) => (
            <div key={item.jobId || item.sheet}>
              {item.sheet} → {item.targetLabel || item.target}：成功 {item.imported}，跳过 {item.skipped}
              {(item.errors || []).slice(0, 3).map((error: any, index: number) => (
                <div key={index} className="di-vision-row-error">
                  第 {error.row || '-'} 行：{error.error || '未通过校验'}
                </div>
              ))}
            </div>
          ))}
        />
      ) : null}
    </div>
  );
}

export default DataIntakeVisionImport;
