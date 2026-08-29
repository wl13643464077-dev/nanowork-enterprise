import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const repositoryDirectory = resolve(desktopDirectory, '..');
const sourcePath = join(repositoryDirectory, 'web/public/brand/nanowork-icon.svg');
const assetDirectory = join(desktopDirectory, 'assets');
const sourceCopyPath = join(assetDirectory, 'icon.svg');
const temporaryDirectory = join(assetDirectory, '.icon-build');
const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

function uint32BigEndian(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function createIcns(images) {
  const entries = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256],
    ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
  ].map(([type, size]) => {
    const image = images.get(size);
    return Buffer.concat([Buffer.from(type, 'ascii'), uint32BigEndian(8 + image.length), image]);
  });
  const body = Buffer.concat(entries);
  return Buffer.concat([Buffer.from('icns', 'ascii'), uint32BigEndian(8 + body.length), body]);
}

function createIco(images) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length + sizes.length * 16;
  const entries = [];
  const payloads = [];
  for (const size of sizes) {
    const image = images.get(size);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(image);
    offset += image.length;
  }
  return Buffer.concat([header, ...entries, ...payloads]);
}

async function renderPng(svg, size) {
  return sharp(svg, { density: 1536 })
    .resize(size, size, { fit: 'contain' })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

async function main() {
  const svg = await readFile(sourcePath);
  await mkdir(assetDirectory, { recursive: true });
  await rm(temporaryDirectory, { recursive: true, force: true });
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    const images = new Map();
    for (const size of pngSizes) {
      const png = await renderPng(svg, size);
      images.set(size, png);
      await writeFile(join(temporaryDirectory, `icon-${size}.png`), png);
    }
    await Promise.all([
      writeFile(sourceCopyPath, svg),
      writeFile(join(assetDirectory, 'icon.png'), images.get(1024)),
      writeFile(join(assetDirectory, 'icon.icns'), createIcns(images)),
      writeFile(join(assetDirectory, 'icon.ico'), createIco(images)),
    ]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  console.log('已从 web/public/brand/nanowork-icon.svg 生成 PNG、ICNS 和 ICO 品牌图标。');
}

main().catch(error => {
  console.error(`图标生成失败：${error.message}`);
  process.exitCode = 1;
});
