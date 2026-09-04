import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Production-mode tests must not share the real application's data directory.
// Copy actual sources/catalogs; reuse dependencies through a read-only-intent
// directory link. Never copy .env, data, sessions or user credentials.
export function stageServerRuntime() {
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-staged-runtime-'));
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(serverDir);
  fs.copyFileSync(path.join(source, 'package.json'), path.join(serverDir, 'package.json'));
  for (const directory of ['src', 'catalog']) {
    fs.cpSync(path.join(source, directory), path.join(serverDir, directory), { recursive: true });
  }
  const dependencyLink = path.join(serverDir, 'node_modules');
  fs.symlinkSync(path.join(source, 'node_modules'), dependencyLink, process.platform === 'win32' ? 'junction' : 'dir');
  return {
    root, serverDir,
    cleanup() {
      fs.unlinkSync(dependencyLink);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
