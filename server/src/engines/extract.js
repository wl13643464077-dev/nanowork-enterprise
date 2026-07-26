// 知识库文件内容提取引擎（零原生依赖）：
// txt/md/csv/json 直读；docx/xlsx 用 adm-zip 解 XML；pdf 用 node:zlib best-effort 提取文本流；图片交由 vision 模型（在路由层处理）
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';

const MAX_ARCHIVE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_PDF_STREAM_BYTES = 8 * 1024 * 1024;

const stripTags = (xml) => xml
  .replace(/<w:p[ >]/g, '\n<w:p ')
  .replace(/<\/w:p>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function safeZip(buf) {
  const zip = new AdmZip(buf);
  let total = 0;
  for (const entry of zip.getEntries()) {
    const size = Number(entry.header?.size || 0);
    total += size;
    if (size > MAX_ARCHIVE_ENTRY_BYTES || total > MAX_ARCHIVE_TOTAL_BYTES) throw new Error('压缩文档展开后超过安全上限');
  }
  return zip;
}

function fromDocx(buf) {
  const zip = safeZip(buf);
  const doc = zip.getEntry('word/document.xml');
  if (!doc) return null;
  return stripTags(zip.readAsText(doc));
}

function fromXlsx(buf) {
  const zip = safeZip(buf);
  // 共享字符串表
  const sstEntry = zip.getEntry('xl/sharedStrings.xml');
  const sst = [];
  if (sstEntry) {
    const xml = zip.readAsText(sstEntry);
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) sst.push(stripTags(m[1]));
  }
  const parts = [];
  for (const entry of zip.getEntries()) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName)) continue;
    const xml = zip.readAsText(entry);
    const rows = [];
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cm[1]; const inner = cm[2];
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
        cells.push(/t="s"/.test(attrs) ? (sst[+v] ?? '') : stripTags(v));
      }
      const line = cells.filter(x => x !== '').join(' | ');
      if (line) rows.push(line);
      if (rows.length >= 300) break;
    }
    if (rows.length) parts.push(rows.join('\n'));
    if (parts.join('\n').length > 12000) break;
  }
  return parts.join('\n\n') || null;
}

// PDF best-effort：解压 FlateDecode 流，提取 Tj/TJ 与括号文本（适用文字型PDF；扫描件返回 null）
function fromPdf(buf) {
  const out = [];
  const raw = buf.toString('latin1');
  let idx = 0;
  while (out.join('').length < 14000) {
    const s = raw.indexOf('stream', idx);
    if (s === -1) break;
    const e = raw.indexOf('endstream', s);
    if (e === -1) break;
    let start = s + 6;
    if (raw[start] === '\r') start++;
    if (raw[start] === '\n') start++;
    const slice = buf.subarray(start, e);
    idx = e + 9;
    let text = null;
    try { text = zlib.inflateSync(slice, { maxOutputLength: MAX_PDF_STREAM_BYTES }).toString('latin1'); }
    catch { text = slice.toString('latin1'); }
    if (!/(Tj|TJ|BT)/.test(text)) continue;
    const pieces = [];
    for (const m of text.matchAll(/\(((?:\\.|[^\\()])*)\)\s*T[jJ]/g)) {
      const t = m[1].replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\\d{3}/g, '');
      if (t.trim()) pieces.push(t);
    }
    for (const m of text.matchAll(/\[((?:\([^)]*\)|[^[\]])*)\]\s*TJ/g)) {
      const inner = [...m[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)].map(x => x[1]).join('');
      if (inner.trim()) pieces.push(inner);
    }
    if (pieces.length) out.push(pieces.join(' '));
  }
  const joined = out.join('\n').replace(/\s{3,}/g, ' ').trim();
  // 中文PDF多为CID编码，latin1 提取出来是乱码——检查可读性（含足够CJK或ASCII词）
  const readable = (joined.match(/[一-龥a-zA-Z0-9]/g) || []).length;
  return joined && readable > joined.length * 0.3 ? joined.slice(0, 14000) : null;
}

export function extractText(buf, ext) {
  const e = String(ext || '').toLowerCase();
  try {
    if (['txt', 'md', 'csv', 'json', 'log'].includes(e)) return buf.toString('utf8').slice(0, 16000);
    if (e === 'docx' || e === 'doc') return fromDocx(buf);
    if (e === 'xlsx' || e === 'xls') return fromXlsx(buf);
    if (e === 'pdf') return fromPdf(buf);
  } catch { return null; }
  return null;
}

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
export const ALLOWED_EXTS = ['txt', 'md', 'csv', 'json', 'docx', 'doc', 'xlsx', 'xls', 'pdf', ...IMAGE_EXTS];
