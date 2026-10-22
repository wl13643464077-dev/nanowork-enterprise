import { useState } from 'react';
import { Alert, Button, Segmented, Tag, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { buildSalesVideoPublishKit, publishKitText } from './salesVideoPublishKitData.js';
import './SalesVideoPublishKit.css';

type PlatformKey = 'douyin' | 'channels' | 'xhs';

/** 带货视频多平台发布包：从已确认口播生成，复制后由老板自行发布。 */
export default function SalesVideoPublishKit({ script, brandName }: { script: any; brandName?: string }) {
  const [platform, setPlatform] = useState<PlatformKey>('douyin');
  const kit = buildSalesVideoPublishKit(script, { brandName });
  if (!kit) return null;
  const piece = kit.platforms[platform];
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制');
    } catch {
      message.warning('浏览器未允许复制，请手动选择文字');
    }
  };
  return (
    <section className="sales-publish-kit" aria-label="多平台发布包">
      <header>
        <div>
          <strong>多平台发布包</strong>
          <span>按已确认口播整理，不新增事实；复制后在各平台 App 内自行发布。</span>
        </div>
        <Segmented
          value={platform}
          onChange={value => setPlatform(value as PlatformKey)}
          options={[
            { label: '抖音', value: 'douyin' },
            { label: '视频号', value: 'channels' },
            { label: '小红书', value: 'xhs' },
          ]}
        />
      </header>
      <dl>
        <dt>封面字</dt>
        <dd>{kit.coverText}</dd>
        <dt>标题</dt>
        <dd>{piece.title}</dd>
        <dt>文案</dt>
        <dd className="sales-publish-kit-caption">{piece.caption}</dd>
        <dt>话题</dt>
        <dd>
          {piece.hashtags.map((tag: string) => (
            <Tag key={tag}>#{tag}</Tag>
          ))}
        </dd>
        <dt>置顶评论</dt>
        <dd>{piece.pinnedComment}</dd>
        <dt>发布建议</dt>
        <dd>{piece.tip}</dd>
      </dl>
      {kit.warnings.map((line: string) => (
        <Alert key={line} type="warning" showIcon message={line} />
      ))}
      <Button icon={<CopyOutlined />} onClick={() => void copy(publishKitText(piece))}>
        复制{piece.label}发布文案
      </Button>
    </section>
  );
}
