import { Alert, Button, Form, Input, Modal, Skeleton, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  ContentBrandPersonaFormValues,
  ContentTenantProfile,
  ContentTenantProfileResponse,
} from '../api/contentProfileTypes';
import './ContentBrandPersonaEditor.css';

type Props = {
  open: boolean;
  onClose: () => void;
};

function lines(value: unknown) {
  if (!Array.isArray(value)) return '';
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .join('\n');
}

function list(value: unknown) {
  return [
    ...new Set(
      String(value || '')
        .split(/[\n,\uff0c\u3001;\uff1b]+/u)
        .map(item => item.trim())
        .filter(Boolean),
    ),
  ];
}

function formValues(profile: ContentTenantProfile): ContentBrandPersonaFormValues {
  return {
    brand: profile.enterprise.brand,
    business: profile.enterprise.business,
    sellingPoints: lines(profile.enterprise.sellingPoints),
    keywords: lines(profile.enterprise.keywords),
    positioning: profile.persona.positioning,
    audience: profile.persona.audience,
    tone: profile.persona.tone,
    catchphrases: lines(profile.persona.catchphrases),
    taboo: lines(profile.persona.taboo),
    styleNotes: profile.persona.style_notes,
    visual: profile.persona.visual,
  };
}

export default function ContentBrandPersonaEditor({ open, onClose }: Props) {
  const [form] = Form.useForm<ContentBrandPersonaFormValues>();
  const [profile, setProfile] = useState<ContentTenantProfile | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setProfile(null);
    try {
      const result = (await api.get('/employee-workbench/content/profile')) as ContentTenantProfileResponse;
      setProfile(result.profile);
      setRevision(Number(result.revision || 0));
      form.setFieldsValue(formValues(result.profile));
    } catch (error: any) {
      setLoadError(error?.message || '企业品牌与账号人设读取失败');
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load, open]);

  const save = async () => {
    if (!profile) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      const result = (await api.put('/employee-workbench/content/profile', {
        expectedRevision: revision,
        profile: {
          brief: profile.brief,
          enterprise: {
            brand: String(values.brand || '').trim(),
            business: String(values.business || '').trim(),
            sellingPoints: list(values.sellingPoints),
            keywords: list(values.keywords),
          },
          persona: {
            positioning: String(values.positioning || '').trim(),
            audience: String(values.audience || '').trim(),
            tone: String(values.tone || '').trim(),
            catchphrases: list(values.catchphrases),
            taboo: list(values.taboo),
            style_notes: String(values.styleNotes || '').trim(),
            visual: String(values.visual || '').trim(),
          },
        },
      })) as ContentTenantProfileResponse;
      setProfile(result.profile);
      setRevision(result.revision);
      message.success('企业品牌与账号人设已保存');
      onClose();
    } catch (error: any) {
      if (/revision|版本|覆盖|刷新/iu.test(String(error?.message || ''))) {
        setLoadError('资料已被其他管理员更新，请刷新后再保存。');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      className="content-brand-persona-modal"
      open={open}
      title="企业品牌与账号人设"
      width={760}
      footer={null}
      destroyOnClose
      onCancel={onClose}
    >
      {loading && <Skeleton active paragraph={{ rows: 7 }} />}
      {!loading && loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError}
          action={
            <Button size="small" onClick={() => void load()}>
              刷新
            </Button>
          }
        />
      )}
      {!loading && !loadError && profile && (
        <Form form={form} layout="vertical" requiredMark={false} onFinish={() => void save()}>
          <section className="content-profile-section" aria-labelledby="content-enterprise-profile-title">
            <header>
              <h3 id="content-enterprise-profile-title">企业品牌</h3>
              <span>只写已确认事实</span>
            </header>
            <div className="content-profile-grid">
              <Form.Item name="brand" label="品牌 / 企业名" rules={[{ max: 500 }]}>
                <Input placeholder="未确认可留空" />
              </Form.Item>
              <Form.Item name="keywords" label="品牌关键词">
                <Input placeholder="用换行或逗号分隔" />
              </Form.Item>
              <Form.Item className="wide" name="business" label="主营业务" rules={[{ max: 4000 }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder="产品、服务与业务范围" />
              </Form.Item>
              <Form.Item className="wide" name="sellingPoints" label="已确认卖点">
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder="每行一条；没有核实的不填" />
              </Form.Item>
            </div>
          </section>

          <section className="content-profile-section" aria-labelledby="content-persona-profile-title">
            <header>
              <h3 id="content-persona-profile-title">账号人设</h3>
              <span>后续内容员工共用</span>
            </header>
            <div className="content-profile-grid">
              <Form.Item name="positioning" label="账号定位" rules={[{ max: 2000 }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
              </Form.Item>
              <Form.Item name="audience" label="目标受众" rules={[{ max: 2000 }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
              </Form.Item>
              <Form.Item name="tone" label="语气与表达" rules={[{ max: 2000 }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
              </Form.Item>
              <Form.Item name="catchphrases" label="常用句式 / 口头禅">
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="每行一条" />
              </Form.Item>
              <Form.Item name="taboo" label="禁忌与红线">
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="每行一条" />
              </Form.Item>
              <Form.Item name="styleNotes" label="文风补充" rules={[{ max: 4000 }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
              </Form.Item>
              <Form.Item className="wide" name="visual" label="视觉规范" rules={[{ max: 4000 }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder="色彩、构图、人物或品牌素材边界" />
              </Form.Item>
            </div>
          </section>

          <div className="content-profile-actions">
            <Button onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
              保存资料
            </Button>
          </div>
        </Form>
      )}
    </Modal>
  );
}
