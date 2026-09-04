import { createHash } from 'node:crypto';
import { resolveXhsSalesContext } from './content-xhs-playbook.js';

const SCHEMA = 'nanowork.content-production-private-output-snapshot/1';
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stable = value => Array.isArray(value) ? value.map(stable) : isObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const outputSnapshotFingerprint = value => `sha256:${createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex')}`;

// This is private validation input, never a public station/evidence/artifact field.
// Hashes bind accidental corruption/replay to the original provider evidence; they
// do not authenticate data against an administrator able to rewrite the whole DB.
export function createPrivateOutputSnapshot({ context, validationContext, employeeIdx, handlerId, output }) {
  if (employeeIdx < 3 || !resolveXhsSalesContext(3, validationContext).salesMode) return null;
  const payload = JSON.parse(JSON.stringify({
    schemaVersion: SCHEMA,
    tenantId: context.tenantId,
    pipelineId: context.jobId,
    stationIdx: employeeIdx,
    stationAttempt: context.workflow?.stationAttempt,
    handlerId,
    outputFingerprint: outputSnapshotFingerprint(output),
    validationContext,
  }));
  // Legacy/non-persistent registry callers have no attempt. They still generate,
  // but cannot obtain a fabricated recoverable snapshot for an unknown attempt.
  if (![payload.tenantId, payload.pipelineId, payload.stationAttempt].every(n => Number.isSafeInteger(n) && n > 0)) return null;
  return { ...payload, snapshotFingerprint: outputSnapshotFingerprint(payload) };
}

export function validatePrivateOutputSnapshot(snapshot, expected) {
  if (!isObject(snapshot)) return null;
  try {
    const copy = JSON.parse(JSON.stringify(snapshot));
    if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > 8 * 1024 * 1024) return null;
    const { snapshotFingerprint, ...payload } = copy;
    if (payload.schemaVersion !== SCHEMA || snapshotFingerprint !== outputSnapshotFingerprint(payload)) return null;
    for (const key of ['tenantId', 'pipelineId', 'stationIdx', 'stationAttempt', 'handlerId']) {
      if (payload[key] !== expected[key]) return null;
    }
    const provider = expected.providerDelivery;
    if (provider?.validated !== true || provider.mode !== 'api'
      || provider.employeeIdx !== payload.stationIdx || provider.handlerId !== payload.handlerId
      || provider.validationSnapshotFingerprint !== snapshotFingerprint
      || provider.outputFingerprint !== payload.outputFingerprint
      || expected.outputFingerprint !== payload.outputFingerprint) return null;
    const context = payload.validationContext;
    if (!isObject(context) || context.executionMode !== 'pipeline'
      || !resolveXhsSalesContext(3, context).salesMode || !isObject(context.storeFacts)) return null;
    if (expected.task && outputSnapshotFingerprint(context.task) !== outputSnapshotFingerprint(expected.task)) return null;
    if (expected.upstreamOutputs && outputSnapshotFingerprint(context.outputs || {}) !== outputSnapshotFingerprint(expected.upstreamOutputs)) return null;
    return copy;
  } catch {
    return null;
  }
}
