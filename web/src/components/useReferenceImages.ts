import { useState } from 'react';
import { message } from 'antd';
import type { ReferenceImage } from './AiSalesVideoPanel';

export const useReferenceImages = () => {
  const [refImgs, setRefImgs] = useState<ReferenceImage[]>([]);

  const onPickRef = async (files: FileList | null) => {
    const incoming = Array.from(files || []);
    if (!incoming.length) return;
    if (refImgs.length + incoming.length > 6) {
      message.error('一次最多上传6张参考图');
      return;
    }
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp']);
    const invalid = incoming.find(file => !allowed.has(file.type) || file.size > 4 * 1024 * 1024);
    if (invalid) {
      message.error(`「${invalid.name}」仅支持 PNG/JPG/WebP，且单张不超过4MB`);
      return;
    }
    const total = [...refImgs.map(image => image.size), ...incoming.map(file => file.size)].reduce(
      (sum, size) => sum + size,
      0,
    );
    if (total > 18 * 1024 * 1024) {
      message.error('参考图合计不能超过18MB');
      return;
    }
    const added = await Promise.all(
      incoming.map(
        file =>
          new Promise<ReferenceImage>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                id: `${Date.now()}-${Math.random()}`,
                name: file.name,
                url: String(reader.result),
                size: file.size,
              });
            reader.onerror = () => reject(new Error(`读取「${file.name}」失败`));
            reader.readAsDataURL(file);
          }),
      ),
    );
    setRefImgs(current => [...current, ...added].slice(0, 6));
  };

  return { refImgs, setRefImgs, onPickRef };
};
