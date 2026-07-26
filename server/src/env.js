import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, '..', '.env');

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#') || !value.includes('=')) continue;
    const separator = value.indexOf('=');
    const key = value.slice(0, separator).trim();
    const raw = value.slice(separator + 1).trim();
    const parsed = raw.length >= 2 && raw[0] === raw.at(-1) && ['"', "'"].includes(raw[0])
      ? raw.slice(1, -1)
      : raw;
    if (key && process.env[key] == null) process.env[key] = parsed;
  }
}
