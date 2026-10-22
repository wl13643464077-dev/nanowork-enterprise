// Presentation only: keep the stored output untouched so system archives and
// feedback hashes still refer to the original generation. Ordinary business
// JSON, diagrams and code examples remain part of the readable report.
function inspectionRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.record_type === 'nanowork_inspection';
}

function campaignMaterialsRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.record_type === 'nanowork-campaign-materials';
}

function internalJson(value) {
  try {
    const parsed = JSON.parse(value);
    return inspectionRecord(parsed) || campaignMaterialsRecord(parsed);
  } catch {
    return false;
  }
}

export function splitReportBody(value) {
  const source = typeof value === 'string' ? value : String(value ?? '');
  const lines = source.match(/[^\n]*\n|[^\n]+$/gu) || [];
  const kept = [];
  const internalBlocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/u.exec(lines[index]);
    if (!opening) {
      kept.push(lines[index]);
      continue;
    }
    const marker = opening[1];
    const info = opening[2].trim();
    const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*\\r?\\n?$`, 'u');
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end])) end += 1;
    const content = lines.slice(index + 1, end).join('');
    const tagged = /^nanowork-(?:inspection|campaign-materials)(?:\s|$)/iu.test(info);
    const jsonFence = !info || /^json(?:\s|$)/iu.test(info);
    if (tagged || (jsonFence && internalJson(content))) {
      internalBlocks.push({ kind: 'inspection', content, complete: end < lines.length });
    } else {
      kept.push(...lines.slice(index, Math.min(end + 1, lines.length)));
    }
    index = end;
  }
  let body = kept.join('');
  // Legacy results may store the archive object on its own without a fence.
  // Require an exact parsed record type; a normal JSON report is preserved.
  if (!internalBlocks.length && internalJson(body.trim())) {
    internalBlocks.push({ kind: 'inspection', content: body, complete: true });
    body = '';
  }
  return { body: internalBlocks.length ? body.trimEnd() : body, internalBlocks };
}

export function cleanReportBody(value) {
  return splitReportBody(value).body;
}
