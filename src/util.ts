export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toIso(date: Date): string {
  return date.toISOString();
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated]`;
}

export function titleFrom(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ');
  if (!line) return 'New conversation';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortValue(entry));
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortValue(value[key]);
  }
  return sorted;
}

export function encodeResult(value: unknown, max = 8000): string {
  const json = JSON.stringify(value) ?? 'null';
  if (json.length <= max) return json;
  return JSON.stringify({ truncated: true, preview: json.slice(0, max) });
}

export function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

export function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  const text = issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return `${path || 'value'}: ${issue.message}`;
    })
    .join('; ');
  return text.slice(0, 500);
}

export function changed(result: { changes: number | bigint }): boolean {
  return Number(result.changes) > 0;
}
