import { sha1Of } from '../util/atomicWrite';
import type { FileDiagnostic } from './diagnostics';

export type VerifyLevel = 0 | 1 | 2 | 3;
export type VerifyCheckKind = 'typecheck' | 'test' | 'lint' | 'build';

export interface VerifyChangeInfo {
  path: string;
  action: 'edit' | 'create' | 'delete';
}

export interface VerificationPolicyInput {
  changes: VerifyChangeInfo[];
  touchedSymbolsOrImports: boolean;
  diagnosticsErrors: number;
  planRequiresCheck?: VerifyCheckKind;
  priorCheckFailed?: boolean;
  packageRootCount: number;
  resolverConfident: boolean;
}

export interface VerificationPlan {
  level: VerifyLevel;
  reasons: string[];
  checks: string[];
  commandKind?: VerifyCheckKind;
  needsInput?: boolean;
}

export const BASE_CHECKS = ['write', 'diagnostics', 'diff'] as const;

export const LEVEL2_CHECKS = ['related-diagnostics', 'references', 'closest-test', 'package-typecheck'] as const;

export const PROJECT_COMMAND_CHECK = 'project-command';

export const RISK_PATH_SEGMENTS = new Set([
  'auth',
  'authentication',
  'authorization',
  'login',
  'logout',
  'session',
  'sessions',
  'token',
  'tokens',
  'oauth',
  'permission',
  'permissions',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'db',
  'database',
  'migration',
  'migrations',
  'sql',
  'schema',
  'api',
  'route',
  'routes',
  'controller',
  'controllers',
  'handler',
  'handlers',
  'middleware',
]);

export const RISK_FILE_PATTERNS: RegExp[] = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^pnpm-workspace\.yaml$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^bun\.lockb$/i,
  /^Cargo\.toml$/i,
  /^go\.mod$/i,
  /^pyproject\.toml$/i,
  /^requirements\.txt$/i,
  /^tsconfig[^/]*\.json$/i,
  /^vite\.config\.[^/]+$/i,
  /^webpack\.config\.[^/]+$/i,
];

export const RISK_ENV_PATTERN = /(^|\/)\.env(\..*)?$/i;

export function matchesRiskPath(value: string): boolean {
  const normalized = (value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (!normalized) {
    return false;
  }
  if (RISK_ENV_PATTERN.test(normalized)) {
    return true;
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => RISK_PATH_SEGMENTS.has(segment))) {
    return true;
  }
  const base = segments[segments.length - 1] ?? '';
  return RISK_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

export function diagnosticsCacheKey(uri: string, text: string): string {
  return `${uri}|${sha1Of(text)}`;
}

export class DiagnosticsCache {
  private readonly entries = new Map<string, FileDiagnostic[]>();

  get(uri: string, text: string): FileDiagnostic[] | undefined {
    return this.entries.get(diagnosticsCacheKey(uri, text));
  }

  set(uri: string, text: string, items: FileDiagnostic[]): void {
    if (this.entries.size >= 200) {
      this.entries.clear();
    }
    this.entries.set(diagnosticsCacheKey(uri, text), items);
  }

  clear(): void {
    this.entries.clear();
  }
}

function level2Reasons(input: VerificationPolicyInput): string[] {
  const reasons: string[] = [];
  if (input.touchedSymbolsOrImports) {
    reasons.push('touched symbols or imports');
  }
  if (input.changes.length >= 2 && input.changes.length <= 4) {
    reasons.push(`${input.changes.length} files changed`);
  }
  if (input.packageRootCount === 1 && input.changes.length > 0) {
    reasons.push('all changes within one package root');
  }
  return reasons;
}

function level3Reasons(input: VerificationPolicyInput): string[] {
  const reasons: string[] = [];
  if (input.changes.length >= 5) {
    reasons.push(`${input.changes.length} files changed`);
  }
  for (const change of input.changes) {
    if (matchesRiskPath(change.path)) {
      reasons.push(`risk path: ${change.path}`);
    }
  }
  if (input.packageRootCount > 1) {
    reasons.push(`${input.packageRootCount} package roots`);
  }
  if (input.planRequiresCheck) {
    reasons.push(`plan requires ${input.planRequiresCheck} check`);
  }
  if (input.priorCheckFailed) {
    reasons.push('previous check failed');
  }
  return reasons;
}

export function planVerification(input: VerificationPolicyInput): VerificationPlan {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  if (changes.length === 0) {
    return { level: 0, reasons: [], checks: [] };
  }
  const checks: string[] = ['write', 'diagnostics'];
  if (changes.some((change) => change.action !== 'create')) {
    checks.push('diff');
  }
  const level2 = level2Reasons(input);
  const level3 = level3Reasons(input);
  let level: VerifyLevel = 1;
  if (level3.length > 0) {
    level = 3;
  } else if (level2.length > 0) {
    level = 2;
  }
  if (level >= 2) {
    checks.push('related-diagnostics');
    if (input.touchedSymbolsOrImports) {
      checks.push('references');
    }
    checks.push('closest-test');
    checks.push('package-typecheck');
  }
  const plan: VerificationPlan = {
    level,
    reasons: level === 3 ? level3 : level === 2 ? level2 : [],
    checks,
  };
  if (level === 3) {
    plan.checks.push(PROJECT_COMMAND_CHECK);
    plan.commandKind = input.planRequiresCheck ?? 'test';
    if (input.resolverConfident === false) {
      plan.needsInput = true;
      plan.reasons.push('no confident project command');
    }
  }
  return plan;
}

const PLAN_CHECK_PATTERNS: Array<{ kind: VerifyCheckKind; patterns: RegExp[] }> = [
  {
    kind: 'test',
    patterns: [
      /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
      /\bcargo\s+test\b/i,
      /\bgo\s+test\b/i,
      /\bpytest\b/i,
      /\bvitest\s+run\b/i,
      /\bjest\b/i,
    ],
  },
  {
    kind: 'typecheck',
    patterns: [
      /\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:typecheck|type-check|tsc)\b/i,
      /\btsc\s+--noEmit\b/i,
      /\bcargo\s+check\b/i,
      /\bgo\s+vet\b/i,
      /\bpyright\b/i,
      /\bmypy\b/i,
    ],
  },
  {
    kind: 'lint',
    patterns: [
      /\b(?:npm|pnpm|yarn|bun)\s+run\s+lint\b/i,
      /\beslint\b/i,
      /\bruff\s+check\b/i,
      /\bcargo\s+clippy\b/i,
    ],
  },
  {
    kind: 'build',
    patterns: [
      /\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b/i,
      /\bcargo\s+build\b/i,
      /\bgo\s+build\b/i,
    ],
  },
];

export function planCheckRequirementFromSteps(steps: string[] | undefined): VerifyCheckKind | undefined {
  if (!Array.isArray(steps) || steps.length === 0) {
    return undefined;
  }
  const text = steps.join('\n');
  for (const entry of PLAN_CHECK_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      return entry.kind;
    }
  }
  return undefined;
}
