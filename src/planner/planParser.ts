import { Plan, PlanContextEntry } from '../shared/protocol';

import { parseJsonLoose } from '../util/json';

export function planFromObject(input: unknown, version: number): Plan | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const fields = new Map<string, unknown>();
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    fields.set(key.toLowerCase().replace(/[^a-z]/g, ''), value);
  }
  const get = (...keys: string[]): unknown => {
    for (const key of keys) {
      const value = fields.get(key);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  };

  const what = firstString(get('what'));
  const how = firstString(get('how'));
  const flow = firstString(get('flow', 'howdiagram', 'diagram', 'mermaid'));
  const why = firstString(get('why'));
  const tradeoff = firstString(get('tradeoff', 'tradeoffs', 'tradeoffanalysis'));
  const leaveAsIs = firstString(get('leaveasis', 'leaveasalone'));
  const concept = firstString(get('concept'));
  const convention = firstString(get('convention'));
  const risks = normalizeRisks(get('risks', 'risk'));
  const whyNot = firstString(get('whynot', 'whynotalternative'));
  const steps = normalizeSteps(get('steps', 'plan', 'actions'));
  const context = normalizeContext(get('context', 'files'));
  const title = firstString(get('title'));
  const intentValue = firstString(get('intent'));
  const intent = intentValue === 'explanation' || intentValue === 'plan' ? intentValue : undefined;
  const trivial = get('trivial') === true || get('trivial') === 'true';

  if (!what && !how && !flow && !why && !tradeoff && !leaveAsIs && !concept && !risks && !whyNot && !steps && !context?.length) {
    return undefined;
  }

  return {
    version,
    status: 'draft',
    intent: intent ?? (steps?.length ? 'plan' : 'explanation'),
    title: title ?? deriveTitle(what, steps),
    what,
    how,
    flow,
    why,
    tradeoff,
    leaveAsIs,
    concept,
    convention,
    risks,
    whyNot,
    context,
    steps,
    trivial: trivial || undefined,
  };
}

function normalizeRisks(value: unknown): string[] | undefined {
  const risks: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) {
        risks.push(item.trim());
      }
    }
  } else if (typeof value === 'string') {
    for (const line of value.split('\n')) {
      const risk = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
      if (risk) {
        risks.push(risk);
      }
    }
  }
  return risks.length > 0 ? risks.slice(0, 2) : undefined;
}

function normalizeContext(value: unknown): PlanContextEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((item) => {
      if (typeof item === 'string' && item.trim()) {
        const [path, ...rest] = item.split(/\s+—\s+|\s+-\s+/);
        return { path: path.trim(), role: rest.join(' ').trim() || 'Referenced file' };
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const path = firstString(record.path, record.file, record.name);
        if (path) {
          return { path, role: firstString(record.role, record.description, record.what) ?? 'Referenced file' };
        }
      }
      return undefined;
    })
    .filter((entry): entry is PlanContextEntry => Boolean(entry));
  return entries.length > 0 ? entries : undefined;
}

export function parsePlanFromText(text: string, version: number): Plan | undefined {
  const json = parseJsonLoose(text);
  if (json === undefined) {
    return undefined;
  }
  return planFromObject(json, version);
}

export function planFromToolCall(argumentsJson: string, version: number): Plan | undefined {
  const json = parseJsonLoose(argumentsJson);
  if (json === undefined) {
    return undefined;
  }
  return planFromObject(json, version);
}

export function deriveTitle(what: string | undefined, steps: string[] | undefined): string {
  const source = what ?? steps?.[0];
  if (!source) {
    return 'Plan';
  }
  const line = source.split('\n')[0].trim();
  return line.length > 72 ? `${line.slice(0, 69).trimEnd()}...` : line;
}

export function planFromText(markdown: string, version: number): Plan | undefined {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const buffers: Record<string, string[]> = {};
  const context: PlanContextEntry[] = [];
  const steps: string[] = [];
  const risks: string[] = [];
  let section: string | null = null;

  for (const line of lines) {
    const header = /^(WHAT|HOW|FLOW|WHY NOT|WHYNOT|WHY|TRADEOFF|LEAVE AS IS|LEAVEASIS|CONCEPT|CONVENTION|RISKS|CONTEXT|PLAN):\s*(.*)$/i.exec(line.trim());
    if (header) {
      section = header[1].toUpperCase().replace(/\s+/g, '');
      buffers[section] = header[2] ? [header[2]] : [];
      continue;
    }
    if (!section) {
      continue;
    }
    if (section === 'CONTEXT') {
      const match = /^[-*]\s*(.+?)(?:\s+—\s+|\s+-\s+)(.*)$/.exec(line.trim());
      if (match) {
        context.push({ path: match[1].trim(), role: match[2].trim() });
      }
      continue;
    }
    if (section === 'RISKS') {
      const match = /^\s*(?:[-*•]|\d+[.)])?\s*(.+)$/.exec(line.trim());
      if (match) {
        risks.push(match[1].trim());
      }
      continue;
    }
    if (section === 'PLAN') {
      const match = /^\s*\d+[.)]\s*(.+)$/.exec(line);
      if (match) {
        steps.push(match[1].trim());
      }
      continue;
    }
    buffers[section] = buffers[section] ?? [];
    buffers[section].push(line);
  }

  const get = (key: string): string | undefined => {
    const value = (buffers[key] ?? []).join('\n').trim();
    return value || undefined;
  };

  const plan: Plan = {
    version,
    status: 'draft',
    intent: steps.length > 0 ? 'plan' : 'explanation',
    what: get('WHAT'),
    how: get('HOW'),
    flow: get('FLOW'),
    why: get('WHY'),
    tradeoff: get('TRADEOFF'),
    leaveAsIs: get('LEAVEASIS'),
    concept: get('CONCEPT'),
    convention: get('CONVENTION'),
    risks: risks.length > 0 ? risks.slice(0, 2) : undefined,
    whyNot: get('WHYNOT'),
    context: context.length > 0 ? context : undefined,
    steps: steps.length > 0 ? steps : undefined,
  };

  if (
    !plan.what &&
    !plan.how &&
    !plan.flow &&
    !plan.why &&
    !plan.tradeoff &&
    !plan.leaveAsIs &&
    !plan.concept &&
    !plan.convention &&
    !plan.risks?.length &&
    !plan.whyNot &&
    !plan.context?.length &&
    !plan.steps?.length
  ) {
    return undefined;
  }
  return plan;
}

export function planSlug(plan: Plan, fallback: string): string {
  const source = plan.title ?? plan.what ?? fallback;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug || 'plan';
}

export function planToText(plan: Plan): string {
  const lines: string[] = [];
  if (plan.what) {
    lines.push(`WHAT: ${plan.what}`);
  }
  if (plan.how) {
    lines.push(`HOW: ${plan.how}`);
  }
  if (plan.flow) {
    lines.push(`FLOW: ${plan.flow}`);
  }
  if (plan.why) {
    lines.push(`WHY: ${plan.why}`);
  }
  if (plan.tradeoff) {
    lines.push(`TRADEOFF: ${plan.tradeoff}`);
  }
  if (plan.concept) {
    lines.push(`CONCEPT: ${plan.concept}`);
  }
  if (plan.convention) {
    lines.push(`CONVENTION: ${plan.convention}`);
  }
  if (plan.risks?.length) {
    lines.push('RISKS:');
    plan.risks.forEach((risk) => lines.push(`- ${risk}`));
  }
  if (plan.whyNot) {
    lines.push(`WHY NOT: ${plan.whyNot}`);
  }
  if (plan.leaveAsIs) {
    lines.push(`LEAVE AS IS: ${plan.leaveAsIs}`);
  }
  if (plan.context?.length) {
    lines.push('CONTEXT:');
    plan.context.forEach((entry) => lines.push(`- ${entry.path} — ${entry.role}`));
  }
  if (plan.steps?.length) {
    lines.push('PLAN:');
    plan.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  return lines.join('\n');
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeSteps(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const steps = value
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          return firstString(record.step, record.text, record.description, record.action);
        }
        return undefined;
      })
      .filter((step): step is string => Boolean(step));
    return steps.length > 0 ? steps : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const steps = value
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);
    return steps.length > 0 ? steps : undefined;
  }
  return undefined;
}
