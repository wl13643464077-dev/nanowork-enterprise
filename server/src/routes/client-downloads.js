import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIRECTORY = fileURLToPath(new URL('../../data/client-downloads/', import.meta.url));
const PLATFORMS = [
  { id: 'mac-arm64', platform: 'mac', arch: 'arm64', label: 'Mac · Apple 芯片' },
  { id: 'mac-x64', platform: 'mac', arch: 'x64', label: 'Mac · Intel 芯片' },
  { id: 'windows-x64', platform: 'windows', arch: 'x64', label: 'Windows · 64位' },
];

function availableReleases(directory) {
  let root;
  let releases = [];
  try {
    root = fs.realpathSync(directory);
    const manifest = path.join(root, 'manifest.json');
    const stat = fs.lstatSync(manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid manifest');
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (Array.isArray(data.releases)) releases = data.releases;
  } catch { /* No published artifacts yet: show availability honestly. */ }
  return PLATFORMS.map(platform => {
    const empty = { ...platform, available: false };
    const matches = releases.filter(release => release?.id === platform.id);
    if (!root || matches.length !== 1) return empty;
    const release = matches[0];
    const extension = platform.platform === 'mac' ? /\.(dmg|zip)$/i : /\.exe$/i;
    if (typeof release.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(release.file)
      || !extension.test(release.file) || typeof release.version !== 'string'
      || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(release.version)
      || !/^[a-f0-9]{64}$/i.test(release.sha256 || '')) return empty;
    try {
      const filePath = path.join(root, release.file);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || fs.realpathSync(filePath) !== filePath) return empty;
      return { ...platform, available: true, filePath, fileName: release.file, bytes: stat.size,
        version: release.version, sha256: release.sha256.toLowerCase(),
        downloadUrl: `/downloads/clients/${platform.id}` };
    } catch { return empty; }
  });
}

export function createClientDownloadsRouter({ directory = process.env.CLIENT_DOWNLOADS_DIR || DEFAULT_DIRECTORY } = {}) {
  const router = Router();
  router.get('/api/public/client-downloads', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ releases: availableReleases(directory).map(({ filePath: _filePath, ...release }) => release) });
  });
  router.get('/downloads/clients/:id', (req, res) => {
    const release = availableReleases(directory).find(item => item.id === req.params.id && item.available);
    if (!release) return res.status(404).json({ error: '此版本安装包暂未上架，请稍后再试。' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=0, must-revalidate' });
    res.download(release.filePath, release.fileName, error => {
      if (error && !res.headersSent) res.status(error.status === 416 ? 416 : 404).json({ error: '安装包暂时不可用，请刷新页面后重试。' });
    });
  });
  router.use('/downloads/clients', (_req, res) => res.status(404).json({ error: '未找到此客户端版本。' }));
  return router;
}

export default createClientDownloadsRouter();
