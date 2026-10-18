import type { ChatMessage } from '../llm/types';
import type { PendingDecisionRecord } from '../shared/protocol';
import type { SessionContextEntry } from '../session/SessionStore';
import { estimateTokens } from '../agent/compaction';
import { messageHash } from '../session/contextIndex';

const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'what', 'when', 'where', 'about', 'there', 'they', 'then', 'your', 'into', 'need']);

const TIER_LINK = 1000;
const TIER_REFERENCE = 400;
const TIER_UNRESOLVED = 150;
const RECENCY_WEIGHT = 40;
const STRONG_MATCH_FLOOR = TIER_UNRESOLVED;
const AMBIGUITY_RATIO = 0.85;
const MAX_AMBIGUOUS = 3;
const RECENT_TAIL = 8;
const SHORT_CONVERSATION = 14;

export interface RelevanceBudget {
  maxOlder: number;
  maxTokens: number;
}

export interface RelevanceOptions {
  archived?: ChatMessage[];
  archivedContextIndex?: SessionContextEntry[];
  pendingDecisionIds?: string[];
}

export interface PinnedPlanContext {
  title: string;
  steps: string[];
  version: number;
  completedSteps: number[];
  skippedSteps: number[];
}

export interface PinnedPlannerContext {
  latestUserMessage: string;
  activePlan?: PinnedPlanContext;
  pending?: PendingDecisionRecord;
  changedFiles: string[];
  diagnosticsSummary?: string;
}

export const RETRIEVED_CONTEXT_HEADER =
  'Earlier context was selected by file, symbol, plan, decision, and semantic links. Treat it as context only; the latest message is the active request.';

export function relevanceBudget(tier: string): RelevanceBudget {
  switch (tier) {
    case 'compact':
      return { maxOlder: 4, maxTokens: 800 };
    case 'large':
      return { maxOlder: 12, maxTokens: 3000 };
    default:
      return { maxOlder: 8, maxTokens: 2000 };
  }
}

function content(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
}

function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}_./:-]{3,}/gu) ?? []).filter((term) => !STOP.has(term)));
}

function entryText(entry: SessionContextEntry | undefined): string {
  if (!entry) {
    return '';
  }
  return `${entry.files.join(' ')} ${entry.symbols.join(' ')} ${entry.planStepIds.join(' ')} ${entry.decisionIds.join(' ')} ${entry.summary ?? ''}`;
}

interface Anchors {
  terms: Set<string>;
  paths: Set<string>;
  symbols: Set<string>;
  stepRefs: Set<string>;
  decisionIds: Set<string>;
  indirect: boolean;
}

function anchorsFor(text: string, pendingDecisionIds: string[]): Anchors {
  const paths = new Set<string>();
  for (const match of text.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g) ?? []) {
    paths.add(match.toLowerCase());
  }
  for (const match of text.match(/\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|rb|cs|swift|kt|css|scss|html|yml|yaml|toml)\b/g) ?? []) {
    paths.add(match.toLowerCase());
  }
  const symbols = new Set<string>();
  for (const match of text.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g) ?? []) {
    symbols.add(match.toLowerCase());
  }
  const stepRefs = new Set<string>();
  for (const match of text.matchAll(/\b(?:step|version|v)\s*(\d+)\b/gi)) {
    stepRefs.add(match[1]);
  }
  const decisionIds = new Set(pendingDecisionIds.map((id) => id.toLowerCase()));
  const indirect = /\b(that|it|continue|earlier|pending|decision|question|again|still)\b/i.test(text);
  return { terms: terms(text), paths, symbols, stepRefs, decisionIds, indirect };
}

function linkMatches(entry: SessionContextEntry, anchors: Anchors): number {
  let matches = 0;
  for (const file of entry.files) {
    const value = file.toLowerCase();
    if (anchors.paths.has(value)) {
      matches++;
      continue;
    }
    if ([...anchors.paths].some((candidate) => value.endsWith(`/${candidate}`) || candidate.endsWith(`/${value}`))) {
      matches++;
    }
  }
  for (const symbol of entry.symbols) {
    if (anchors.symbols.has(symbol.toLowerCase())) {
      matches++;
    }
  }
  for (const id of entry.decisionIds) {
    if (anchors.decisionIds.has(id.toLowerCase())) {
      matches++;
    }
  }
  for (const id of entry.planStepIds) {
    const value = id.replace(/^step[:_-]?/i, '');
    if (anchors.stepRefs.has(id) || anchors.stepRefs.has(value)) {
      matches++;
    }
  }
  return matches;
}

interface Candidate {
  message: ChatMessage;
  entry?: SessionContextEntry;
  index: number;
  score: number;
}

function scoreCandidate(message: ChatMessage, entry: SessionContextEntry | undefined, anchors: Anchors): number {
  if (entry) {
    const links = linkMatches(entry, anchors);
    if (links > 0) {
      return TIER_LINK + links * 25;
    }
  }
  const overlap = [...terms(`${content(message)} ${entryText(entry)}`)].filter((term) => anchors.terms.has(term)).length;
  if (overlap > 0) {
    return TIER_REFERENCE + overlap * 10;
  }
  if (anchors.indirect && entry && (entry.decisionIds.length > 0 || entry.planStepIds.length > 0)) {
    return TIER_UNRESOLVED;
  }
  return 0;
}

function earlierWorkSummary(entries: SessionContextEntry[]): string | undefined {
  const summaries = entries.map((entry) => entry.summary?.trim()).filter((summary): summary is string => Boolean(summary));
  const files = [...new Set(entries.flatMap((entry) => entry.files))].slice(0, 4);
  const parts: string[] = [];
  if (summaries.length > 0) {
    parts.push(summaries.slice(-3).join('; '));
  }
  if (files.length > 0) {
    parts.push(`files: ${files.join(', ')}`);
  }
  return parts.length > 0 ? `Earlier work — ${parts.join(' — ')}` : undefined;
}

interface SelectionResult {
  messages: ChatMessage[];
  retrieved: boolean;
  ambiguous: boolean;
  summary?: string;
}

function metadataFor(
  conversation: ChatMessage[],
  contextIndex: SessionContextEntry[],
): (message: ChatMessage, index: number) => SessionContextEntry | undefined {
  const byHash = new Map(contextIndex.map((entry) => [entry.hash, entry]));
  return (message, index) => byHash.get(messageHash(message)) ?? contextIndex[index];
}

function selectWithAnchors(
  conversation: ChatMessage[],
  budget: RelevanceBudget,
  contextIndex: SessionContextEntry[],
  pendingDecisionIds: string[],
): SelectionResult {
  if (conversation.length <= SHORT_CONVERSATION) {
    return { messages: conversation, retrieved: false, ambiguous: false };
  }
  const latest = conversation[conversation.length - 1];
  const latestText = content(latest).trim();
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|got it|understood)[!.\s]*$/i.test(latestText)) {
    return { messages: conversation.slice(-2), retrieved: false, ambiguous: false };
  }
  // Without a multilingual embedding index, preserve full context for non-Latin
  // or highly ambiguous turns rather than risking a false omission.
  if (/[^\u0000-\u024f]/u.test(content(latest))) {
    return { messages: conversation, retrieved: false, ambiguous: false };
  }
  const recentStart = Math.max(0, conversation.length - RECENT_TAIL);
  const recent = conversation.slice(recentStart);
  const older = conversation.slice(0, recentStart);
  const metadata = metadataFor(conversation, contextIndex);
  const anchors = anchorsFor(content(latest), pendingDecisionIds);
  const candidates: Candidate[] = older.map((message, index) => {
    const entry = metadata(message, index);
    const recency = (index / Math.max(1, older.length)) * RECENCY_WEIGHT;
    return { message, entry, index, score: scoreCandidate(message, entry, anchors) + recency };
  });
  const ranked = candidates.slice().sort((a, b) => b.score - a.score || a.index - b.index);
  const strong = ranked.filter((candidate) => candidate.score >= STRONG_MATCH_FLOOR);
  if (strong.length === 0) {
    const summary = earlierWorkSummary(candidates.map((candidate) => candidate.entry).filter((entry): entry is SessionContextEntry => Boolean(entry)));
    return { messages: recent, retrieved: false, ambiguous: false, ...(summary ? { summary } : {}) };
  }
  const topScore = strong[0].score;
  const ambiguousGroup = strong.filter((candidate) => candidate.score >= topScore * AMBIGUITY_RATIO);
  const limit = ambiguousGroup.length > 1 ? Math.min(MAX_AMBIGUOUS, budget.maxOlder) : budget.maxOlder;
  const chosen: Candidate[] = [];
  let tokens = 0;
  for (const candidate of strong) {
    if (chosen.length >= limit) {
      break;
    }
    const cost = estimateTokens([candidate.message]);
    if (chosen.length > 0 && tokens + cost > budget.maxTokens) {
      break;
    }
    tokens += cost;
    chosen.push(candidate);
  }
  chosen.sort((a, b) => a.index - b.index);
  const ambiguous = chosen.length > 1 && ambiguousGroup.length > 1;
  const summary = ambiguous ? earlierWorkSummary(ranked.map((candidate) => candidate.entry).filter((entry): entry is SessionContextEntry => Boolean(entry))) : undefined;
  return {
    messages: [...chosen.map((candidate) => candidate.message), ...recent],
    retrieved: chosen.length > 0,
    ambiguous,
    ...(summary ? { summary } : {}),
  };
}

/** Select older planner context conservatively; the full transcript remains stored. */
export function selectPlannerConversation(
  conversation: ChatMessage[],
  maxOlder: number | RelevanceBudget = 8,
  contextIndex: SessionContextEntry[] = [],
  options: RelevanceOptions = {},
): ChatMessage[] {
  const budget = typeof maxOlder === 'number' ? { maxOlder, maxTokens: Number.POSITIVE_INFINITY } : maxOlder;
  const combined = [...(options.archived ?? []), ...conversation];
  const combinedIndex = [...(options.archivedContextIndex ?? []), ...contextIndex];
  return selectWithAnchors(combined, budget, combinedIndex, options.pendingDecisionIds ?? []).messages;
}

export function pinnedContextMessage(pinned: PinnedPlannerContext): ChatMessage {
  const lines = [`Latest request: ${pinned.latestUserMessage}`];
  if (pinned.activePlan) {
    const plan = pinned.activePlan;
    const skipped = new Set(plan.skippedSteps);
    const completed = new Set(plan.completedSteps);
    lines.push(`Active plan v${plan.version}: ${plan.title}`);
    const steps = plan.steps.map(
      (step, index) => `${index + 1}. ${step}${skipped.has(index) ? ' [skipped]' : ''}${completed.has(index) ? ' [done]' : ''}`,
    );
    if (steps.length > 0) {
      lines.push(steps.join('\n'));
    }
  }
  if (pinned.pending) {
    lines.push(`Pending ${pinned.pending.kind}: ${pinned.pending.prompt}`);
  }
  if (pinned.changedFiles.length > 0) {
    lines.push(`Changed files: ${pinned.changedFiles.slice(0, 12).join(', ')}`);
  }
  if (pinned.diagnosticsSummary) {
    lines.push(`Diagnostics: ${pinned.diagnosticsSummary}`);
  }
  return { role: 'system', content: `[Pinned context — always included]\n${lines.join('\n')}` };
}

export interface PlannerRequestInput {
  conversation: ChatMessage[];
  contextIndex?: SessionContextEntry[];
  archived?: ChatMessage[];
  archivedContextIndex?: SessionContextEntry[];
  pendingDecisionIds?: string[];
  budget?: RelevanceBudget;
  pinned?: PinnedPlannerContext;
  compact?: (messages: ChatMessage[]) => ChatMessage[];
  completedRunBoundary?: boolean;
}

export interface PlannerRequestResult {
  messages: ChatMessage[];
  retrieved: boolean;
  ambiguous: boolean;
  summary?: string;
}

export function composePlannerRequest(input: PlannerRequestInput): PlannerRequestResult {
  const combined = [...(input.archived ?? []), ...input.conversation];
  const combinedIndex = [...(input.archivedContextIndex ?? []), ...(input.contextIndex ?? [])];
  const selection = selectWithAnchors(
    combined,
    input.budget ?? relevanceBudget('standard'),
    combinedIndex,
    input.pendingDecisionIds ?? [],
  );
  const messages: ChatMessage[] = [];
  if (selection.retrieved) {
    messages.push({ role: 'system', content: RETRIEVED_CONTEXT_HEADER });
  }
  if (input.pinned) {
    messages.push(pinnedContextMessage(input.pinned));
  }
  if (selection.summary) {
    messages.push({ role: 'system', content: selection.summary });
  }
  if (input.completedRunBoundary) {
    messages.push({
      role: 'system',
      content: '[New request boundary] The previous task is complete. Keep the conversation history as context, but do not continue or repeat its plan unless the latest user message explicitly asks for that.',
    });
  }
  messages.push(...selection.messages);
  // The latest user request is the active instruction. Keep it even when
  // relevance selection or compaction drops older conversation entries.
  const latestUser = [...input.conversation].reverse().find((message) => message.role === 'user');
  if (latestUser && !messages.some((message) => message.id && latestUser.id && message.id === latestUser.id)) {
    messages.push(latestUser);
  }
  return {
    messages: input.compact ? input.compact(messages) : messages,
    retrieved: selection.retrieved,
    ambiguous: selection.ambiguous,
    ...(selection.summary ? { summary: selection.summary } : {}),
  };
}
