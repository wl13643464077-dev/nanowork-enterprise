import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateArtifacts, ensurePrivateDataDirectory } from './private-artifact.js';

const insideDirectory = (target, directory) => {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function usesWalHeader(databasePath) {
  if (!fs.existsSync(databasePath)) return false;
  const descriptor = fs.openSync(databasePath, 'r');
  try {
    const header = Buffer.alloc(20);
    const length = fs.readSync(descriptor, header, 0, header.length, 0);
    return length === 20 && header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) &&
      header[18] === 2 && header[19] === 2;
  } finally { fs.closeSync(descriptor); }
}

export function prepareDatabaseStorage({ databasePath, dataDirectory, protectDataDirectory = true,
  trustedDataDirectory = process.env.NANOWORK_DATA_DIR || null }) {
  process.umask(0o077);
  const ownedDirectory = protectDataDirectory
    ? ensurePrivateDataDirectory(dataDirectory, { trustedDirectory: trustedDataDirectory }) : null;
  if (databasePath === ':memory:') return;
  const absolute = path.resolve(databasePath);
  let realParent = null;
  try { realParent = fs.realpathSync(path.dirname(absolute)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let realData = ownedDirectory;
  if (!realData) {
    try { realData = fs.realpathSync(dataDirectory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!protectDataDirectory && (insideDirectory(absolute, dataDirectory) ||
    (realData && realParent && insideDirectory(realParent, realData)))) {
    throw new Error('Isolated test database must not use the application data directory');
  }
  if (ownedDirectory && realParent &&
    (insideDirectory(absolute, dataDirectory) || insideDirectory(absolute, ownedDirectory)) &&
    !insideDirectory(realParent, ownedDirectory)) {
    throw new Error('Database directory must not escape the owned application data directory');
  }
  // The owned application directory is protected independently of NANOWORK_DB.
  // A custom database's containing directory is never changed.
  const existing = ['', '-wal', '-shm', '-journal'].map(suffix => absolute + suffix).filter(file => {
    // existsSync follows links and misses a dangling malicious database/sidecar.
    try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  if (process.platform === 'win32') {
    // SQLite deletes WAL/SHM on last close. Re-establish protected empty files
    // before each opener can put database bytes into them, preserving any hot WAL.
    const required = [absolute, `${absolute}-wal`, `${absolute}-shm`];
    // Entering WAL from a new/DELETE-mode database uses a rollback journal.
    // Do not leave an unused empty journal beside already-WAL databases.
    if (!usesWalHeader(absolute)) required.push(`${absolute}-journal`);
    ensurePrivateArtifacts([...new Set([...existing, ...required])]);
  } else {
    ensurePrivateArtifacts(existing);
  }
}
