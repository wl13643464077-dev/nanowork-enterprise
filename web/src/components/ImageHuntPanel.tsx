import { CheckCircleOutlined, ImportOutlined, SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Empty, Form, Input, Modal, Spin, Tag, message } from 'antd';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import './ImageHuntPanel.css';

type ImageHuntCandidate = {
  title: string;
  imageUrl: string;
  thumbnailUrl?: string;
  sourceUrl?: string | null;
  provider: string;
  rights?: {
    status?: string;
    commercialUse?: boolean;
    note?: string;
  };
};

type ImageHuntResponse = {
  query: string;
  results: ImageHuntCandidate[];
  providerCount: number;
  rightsVerified: false;
  externalCall: true;
};

function thumbnailUrl(candidate: ImageHuntCandidate) {
  return `/api/imagehunt/thumb?url=${encodeURIComponent(candidate.thumbnailUrl || candidate.imageUrl)}`;
}

export function ImageHuntPanel() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ImageHuntResponse | null>(null);
  const [selected, setSelected] = useState<ImageHuntCandidate | null>(null);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [license, setLicense] = useState('');
  const [attribution, setAttribution] = useState('');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<Record<string, number>>({});

  const canImport = useMemo(
    () => Boolean(selected && rightsConfirmed && license.trim()),
    [license, rightsConfirmed, selected],
  );

  const search = async () => {
    const normalized = query.replace(/\s+/g, ' ').trim();
    if (normalized.length < 2) {
      message.warning('请输入至少2个字的素材关键词');
      return;
    }
    setLoading(true);
    try {
      const result = (await api.get(`/imagehunt?q=${encodeURIComponent(normalized)}&limit=24`)) as ImageHuntResponse;
      setResponse({ ...result, results: Array.isArray(result.results) ? result.results : [] });
      if (!result.results?.length) message.info('没有找到可安全预览的图片候选，请更换关键词');
    } finally {
      setLoading(false);
    }
  };

  const beginImport = (candidate: ImageHuntCandidate) => {
    setSelected(candidate);
    setRightsConfirmed(false);
    setLicense('');
    setAttribution('');
  };

  const importMaterial = async () => {
    if (!selected || !canImport) return;
    setImporting(true);
    try {
      const result = await api.post('/imagehunt/import', {
        title: selected.title,
        imageUrl: selected.imageUrl,
        sourceUrl: selected.sourceUrl || null,
        provider: selected.provider,
        rightsConfirmed: true,
        license: license.trim(),
        attribution: attribution.trim(),
      });
      setImported(current => ({ ...current, [selected.imageUrl]: Number(result.materialId) }));
      message.success(
        result.alreadyImported
          ? `该图片已在素材库中（素材 #${result.materialId}）`
          : `已保存为版权确认素材 #${result.materialId}`,
      );
      setSelected(null);
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="imagehunt-panel" aria-label="联网搜图与版权确认导入">
      <div className="imagehunt-heading">
        <div>
          <span>PAIHUO IMAGEHUNT PARITY</span>
          <h3>联网搜图与素材入库</h3>
          <p>从多路公开图片搜索中找候选；预览不等于获得商用权，确认授权后才会保存到内容素材库。</p>
        </div>
        <Tag color="blue">Bing · 百度 · 360</Tag>
      </div>

      <div className="imagehunt-search">
        <Input
          size="large"
          value={query}
          maxLength={200}
          prefix={<SearchOutlined />}
          placeholder="例：太原毛血旺 门店实拍、川菜红油食材、城市夜景"
          onChange={event => setQuery(event.target.value)}
          onPressEnter={() => void search()}
        />
        <Button type="primary" size="large" loading={loading} onClick={() => void search()}>
          搜索图片
        </Button>
      </div>

      <Alert
        type="warning"
        showIcon
        message="版权门禁"
        description="搜索结果只作候选预览。系统不会把未核验图片直接交给内容团队，也不会把“能下载”冒充“可商用”。"
      />

      <Spin spinning={loading}>
        {response?.results?.length ? (
          <div className="imagehunt-grid">
            {response.results.map(candidate => {
              const materialId = imported[candidate.imageUrl];
              return (
                <article key={candidate.imageUrl} className="imagehunt-card">
                  <div className="imagehunt-preview">
                    <img src={thumbnailUrl(candidate)} alt={candidate.title} loading="lazy" />
                  </div>
                  <div className="imagehunt-card-body">
                    <strong title={candidate.title}>{candidate.title}</strong>
                    <div className="imagehunt-meta">
                      <Tag>{candidate.provider}</Tag>
                      <span>授权未核验</span>
                    </div>
                    <div className="imagehunt-actions">
                      {candidate.sourceUrl ? (
                        <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">
                          查看原始页面
                        </a>
                      ) : (
                        <span>未提供原始页面</span>
                      )}
                      {materialId ? (
                        <Tag icon={<CheckCircleOutlined />} color="green">
                          素材 #{materialId}
                        </Tag>
                      ) : (
                        <Button size="small" icon={<ImportOutlined />} onClick={() => beginImport(candidate)}>
                          核权后导入
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : response ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可安全预览的图片候选" />
        ) : (
          <div className="imagehunt-placeholder">
            <SearchOutlined />
            <strong>先输入本次内容需要的具体画面</strong>
            <span>搜图会访问公开搜索服务；只有人工确认权利信息后，图片才进入租户素材库。</span>
          </div>
        )}
      </Spin>

      <Modal
        title="确认图片权利并导入素材库"
        open={!!selected}
        confirmLoading={importing}
        okText="确认授权并导入"
        cancelText="取消"
        okButtonProps={{ disabled: !canImport }}
        onOk={() => void importMaterial()}
        onCancel={() => setSelected(null)}
      >
        <Form layout="vertical" requiredMark={false}>
          <Alert
            type="info"
            showIcon
            message={selected?.title || '图片候选'}
            description="请依据原始页面、供应商许可或你持有的授权文件填写，不要凭图片可见性猜测版权。"
          />
          <Form.Item label="授权 / 许可类型" required>
            <Input
              value={license}
              maxLength={200}
              placeholder="例：自有拍摄、品牌书面授权、CC BY 4.0、商业图库订单号"
              onChange={event => setLicense(event.target.value)}
            />
          </Form.Item>
          <Form.Item label="署名或授权依据（可选）">
            <Input.TextArea
              rows={3}
              maxLength={300}
              placeholder="作者/机构、订单号、授权文件位置、必须保留的署名"
              onChange={event => setAttribution(event.target.value)}
            />
          </Form.Item>
          <Checkbox checked={rightsConfirmed} onChange={event => setRightsConfirmed(event.target.checked)}>
            我已核验该图片的使用权与署名要求，并对本次商用负责。
          </Checkbox>
        </Form>
      </Modal>
    </section>
  );
}
