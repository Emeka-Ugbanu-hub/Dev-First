import { LLMProvider } from '../llm/types';
import { LearnMoreLink, Plan } from '../shared/protocol';
import { parseJsonLoose } from '../util/json';
import { planToText } from '../planner/planParser';

const MAX_LINKS = 4;
const VERIFY_TIMEOUT_MS = 4000;
const VERIFY_TTL_MS = 60 * 60 * 1000;

const verifyCache = new Map<string, { ok: boolean; at: number }>();

export function buildLearnMorePrompt(plan: Plan, request: string): { system: string; user: string } {
  return {
    system: `You find learning resources for a software task.
Prefer, in order: (1) the same technique in the same language/framework, (2) the same technique in another language/framework, (3) related conceptual material.
Cover the technique or subject being implemented, the technologies involved, and each alternative named in the plan.
Never invent URLs — only well-known, real pages (official docs, reputable blogs, YouTube videos, GitHub repositories).
For every link, write a one-line "why" explaining how it relates to this specific task.
Output ONLY JSON: {"chosen":[{"title":"","url":"","why":""}],"alternatives":[{"title":"","url":"","why":""}]}.
At most ${MAX_LINKS} links per group. Omit "alternatives" when the plan has no real alternative.`,
    user: `Task: ${request}\n\nPlan:\n${planToText(plan)}`,
  };
}

export function normalizeLinks(value: unknown): LearnMoreLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const links: LearnMoreLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (!/^https?:\/\//i.test(url) || !title || seen.has(url)) {
      continue;
    }
    seen.add(url);
    links.push({
      title,
      url,
      why: typeof record.why === 'string' && record.why.trim() ? record.why.trim() : undefined,
    });
    if (links.length >= MAX_LINKS) {
      break;
    }
  }
  return links;
}

export function parseLearnMore(text: string): { chosen: LearnMoreLink[]; alternatives: LearnMoreLink[] } | undefined {
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const chosen = normalizeLinks(record.chosen);
  const alternatives = normalizeLinks(record.alternatives);
  if (chosen.length === 0 && alternatives.length === 0) {
    return undefined;
  }
  return { chosen, alternatives };
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export async function verifyLink(url: string): Promise<boolean> {
  const cached = verifyCache.get(url);
  if (cached && Date.now() - cached.at < VERIFY_TTL_MS) {
    return cached.ok;
  }
  const ok = await probe(url, 'HEAD').then((result) => result || probe(url, 'GET'));
  verifyCache.set(url, { ok, at: Date.now() });
  return ok;
}

async function probe(url: string, method: 'HEAD' | 'GET'): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method, redirect: 'follow', signal: controller.signal });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function filterVerified(links: LearnMoreLink[]): Promise<LearnMoreLink[]> {
  const results = await Promise.all(links.map(async (link) => ((await verifyLink(link.url)) ? link : undefined)));
  return results.filter((link): link is LearnMoreLink => Boolean(link));
}

export async function fetchLearnMore(
  provider: LLMProvider,
  model: string,
  plan: Plan,
  request: string,
  signal: AbortSignal,
): Promise<{ chosen: LearnMoreLink[]; alternatives: LearnMoreLink[] }> {
  const prompt = buildLearnMorePrompt(plan, request);
  let raw = '';
  for await (const event of provider.chat(
    [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    { model, maxTokens: 1200, temperature: 0.2, signal },
  )) {
    if (event.type === 'text') {
      raw += event.text;
    }
  }
  const parsed = parseLearnMore(raw);
  if (!parsed) {
    return { chosen: [], alternatives: [] };
  }
  const [chosen, alternatives] = await Promise.all([filterVerified(parsed.chosen), filterVerified(parsed.alternatives)]);
  return { chosen, alternatives };
}
