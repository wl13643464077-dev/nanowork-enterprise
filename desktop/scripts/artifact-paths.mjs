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
