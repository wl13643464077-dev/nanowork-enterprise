import { relative } from 'node:path';

export function toPortablePath(path) {
  return String(path).replaceAll('\\', '/');
}

export function toArtifactName(outputDirectory, path) {
  return toPortablePath(relative(outputDirectory, path));
}

export function isPackagedAsarName(name) {
  return /(^|\/)resources\/app\.asar$/i.test(toPortablePath(name));
}

export function normalizeAsarEntryName(name) {
  return toPortablePath(name).replace(/^\/+/, '');
}

export function isAllowedAsarEntryName(name) {
  return /^(node_modules(?:\/|$)|assets(?:$|\/icon\.png$)|renderer(?:\/|$)|src(?:\/|$)|package\.json$)/.test(
    normalizeAsarEntryName(name),
  );
}
