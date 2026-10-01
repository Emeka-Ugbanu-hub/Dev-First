import { parseJsonLoose } from './json';

export function normalizeToolArguments(raw: string, parameters: Record<string, unknown>): string {
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return raw;
  }
  const properties = (parameters as { properties?: Record<string, any> }).properties ?? {};
  const normalized: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };

  for (const [key, schema] of Object.entries<any>(properties)) {
    if (!(key in normalized)) {
      continue;
    }
    const value = normalized[key];
    const type = schema?.type;

    if (typeof value === 'string') {
      if (type === 'array' || type === 'object') {
        const inner = parseJsonLoose(value);
        if (inner !== undefined && (type === 'array' ? Array.isArray(inner) : typeof inner === 'object')) {
          normalized[key] = inner;
          continue;
        }
      }
      if (type === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) {
        normalized[key] = Number(value);
        continue;
      }
      if (type === 'boolean' && (value === 'true' || value === 'false')) {
        normalized[key] = value === 'true';
      }
      continue;
    }

    if (type === 'string' && typeof value === 'number') {
      normalized[key] = String(value);
    }
  }

  return JSON.stringify(normalized);
}
