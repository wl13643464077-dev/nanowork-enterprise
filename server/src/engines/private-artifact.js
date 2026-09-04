import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const aclScript = fileURLToPath(new URL('./windows-private-artifact.ps1', import.meta.url));

function aclInvocation(paths, operation) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return { executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-File', aclScript, '-Operation', operation], options: {
    input: JSON.stringify({ paths: paths.map(item => path.resolve(item)) }),
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  } };
}

function aclReadback(paths, stdout) {
  const rows = JSON.parse(stdout.replace(/^\uFEFF/u, '').trim());
  if (!Array.isArray(rows) || rows.length !== paths.length) throw new Error('Incomplete Windows ACL readback');
  for (let index = 0; index < rows.length; index += 1) {
    if (path.resolve(rows[index].path).toLowerCase() !== path.resolve(paths[index]).toLowerCase() ||
      typeof rows[index].sddl !== 'string' || !rows[index].sddl) throw new Error('Mismatched Windows ACL readback');
  }
  return rows;
}

function windowsAcl(paths, operation) {
  const { executable, args, options } = aclInvocation(paths, operation);
  const result = spawnSync(executable, args, options);
  if (result.error || result.status !== 0) {
    throw new Error(`Windows artifact ACL ${operation} failed`, {
      cause: result.error || new Error(result.stderr.trim().slice(0, 1200)),
    });
  }
  return aclReadback(paths, result.stdout);
}

function regularSingleLinkFile(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('Private artifact must be an unaliased regular file');
  }
  return stat;
}

// Only use on a new, owned temporary artifact, before writing sensitive data.
// Never applies permissions recursively or modifies the containing directory.
export function protectPrivateArtifact(target) {
  regularSingleLinkFile(target);
  if (process.platform === 'win32') {
    const [result] = windowsAcl([target], 'protect');
    if (result.private !== true) throw new Error('Windows artifact ACL was not private');
  } else {
    fs.chmodSync(target, 0o600);
  }
}

export function assertPrivateArtifact(target) {
  const stat = regularSingleLinkFile(target);
  if (process.platform === 'win32') {
    if (windowsAcl([target], 'inspect')[0].private !== true) {
      throw new Error('checkpoint权限必须为当前账号专用Windows ACL');
    }
  } else if ((stat.mode & 0o777) !== 0o600) {
    throw new Error('checkpoint权限必须是0600');
  }
}

export function windowsAclFingerprints(paths) {
  if (process.platform !== 'win32' || !paths.length) return [];
  return windowsAcl(paths, 'inspect').map(row =>
    createHash('sha256').update(row.sddl).digest('hex'));
}

export function inspectWindowsPermissions(paths) {
  if (process.platform !== 'win32') throw new Error('Windows ACL inspection is Windows-only');
  return windowsAcl(paths, 'inspect');
}

export function ensurePrivateArtifacts(paths) {
  // Preflight every existing target before making any changes.
  for (const target of paths) {
    try { regularSingleLinkFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (process.platform === 'win32') {
    if (!windowsAcl(paths, 'ensure-files').every(row => row.private === true)) throw new Error('Database ACL protection failed');
  } else {
    for (const target of paths) {
      if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
      else createPrivateArtifact(target);
    }
  }
}

// A caller must pass the exact owned application data directory, never a custom
// database's parent or a system directory. No recursive enumeration is performed.
export function ensurePrivateDataDirectory(target) {
  const absolute = path.resolve(target);
  if (absolute === path.parse(absolute).root) throw new Error('Refusing filesystem root ACL change');
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Application data directory must not be an alias');
  }
  if (process.platform === 'win32') {
    if (!windowsAcl([absolute], 'ensure-directory')[0].private) throw new Error('Application data directory is not private');
  } else {
    if (!fs.existsSync(absolute)) fs.mkdirSync(absolute, { mode: 0o700 });
    fs.chmodSync(absolute, 0o700);
  }
}

export function createPrivateArtifact(target) {
  if (process.platform === 'win32') {
    if (windowsAcl([target], 'create')[0].private !== true) throw new Error('Windows artifact ACL was not private');
    return;
  }
  const descriptor = fs.openSync(target, 'wx', 0o600);
  fs.closeSync(descriptor);
}

export function writePrivateArtifact(target, data, { overwrite = false } = {}) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  let descriptor;
  let created = false;
  try {
    createPrivateArtifact(temporary);
    created = true;
    descriptor = fs.openSync(temporary, 'r+');
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (overwrite) fs.renameSync(temporary, target);
    else fs.linkSync(temporary, target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

export async function writePrivateArtifactAsync(target, data) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle;
  let created = false;
  try {
    if (process.platform === 'win32') {
      const { executable, args, options } = aclInvocation([temporary], 'create');
      const { input, ...execOptions } = options;
      const stdout = await new Promise((resolve, reject) => {
        const child = execFile(executable, args, execOptions, (error, output) => {
          if (error) reject(new Error('Windows artifact ACL create failed', { cause: error }));
          else resolve(output);
        });
        child.stdin.on('error', (error) => reject(error));
        child.stdin.end(input);
      });
      if (aclReadback([temporary], stdout)[0].private !== true) throw new Error('Windows artifact ACL was not private');
      created = true;
      handle = await fsp.open(temporary, 'r+');
    } else {
      handle = await fsp.open(temporary, 'wx', 0o600);
      created = true;
    }
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.link(temporary, target);
  } finally {
    if (handle) await handle.close();
    if (created) {
      try { await fsp.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
