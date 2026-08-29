export function parseGrowthSuggestions(value: string): string[] {
  if (!value) return [];
  const numbered = value
    .split(/(?:^|\n)\s*\d+[.、．)）]\s*/)
    .map(item => item.trim())
    .filter(Boolean);
  if (numbered.length >= 2) return numbered.slice(0, 3);
  return value
    .split(/\n+/)
    .map(item => item.replace(/^[-·]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
}
