import type { FileDiagnostic } from './diagnostics';

export type CompoundStatus = 'verified' | 'needs_input' | 'blocked' | 'failed';
export type VerificationLevel = 'full' | 'partial' | 'none';

export interface CompoundDiagnostic {
  file: string;
  line: number;
  severity: string;
  message: string;
}

export interface CompoundEvidence {
  kind: string;
  summary: string;
  file?: string;
  line?: number;
}

export interface CompoundVerification {
  level: VerificationLevel;
  checks: string[];
}

export interface ProposedChangeValidation {
  path: string;
  oldText: string;
  newText: string;
  ok: boolean;
  line?: number;
  reason?: string;
}

export interface CompoundCoverage {
  operations: number;
  files: number;
  skipped: number;
}

export interface CompoundResult {
  status: CompoundStatus;
  files: string[];
  diff?: string;
  diagnostics?: CompoundDiagnostic[];
  evidence?: CompoundEvidence[];
  verification: CompoundVerification;
  rollbackAvailable: boolean;
  message?: string;
  truncated?: boolean;
  skipped?: string[];
  proposedChangeSet?: ProposedChangeValidation[];
  coverage?: CompoundCoverage;
}

export interface CompoundResultPartial {
  status: CompoundStatus;
  files?: string[];
  diff?: string;
  diagnostics?: CompoundDiagnostic[];
  evidence?: CompoundEvidence[];
  verification?: Partial<CompoundVerification>;
  rollbackAvailable?: boolean;
  message?: string;
  truncated?: boolean;
  skipped?: string[];
  proposedChangeSet?: ProposedChangeValidation[];
  coverage?: CompoundCoverage;
}

export function buildCompoundResult(partial: CompoundResultPartial): CompoundResult {
  return {
    status: partial.status,
    files: partial.files ?? [],
    ...(partial.diff !== undefined ? { diff: partial.diff } : {}),
    ...(partial.diagnostics !== undefined ? { diagnostics: partial.diagnostics } : {}),
    ...(partial.evidence !== undefined ? { evidence: partial.evidence } : {}),
    verification: {
      level: partial.verification?.level ?? 'none',
      checks: partial.verification?.checks ?? [],
    },
    rollbackAvailable: partial.rollbackAvailable ?? false,
    ...(partial.message !== undefined ? { message: partial.message } : {}),
    ...(partial.truncated !== undefined ? { truncated: partial.truncated } : {}),
    ...(partial.skipped !== undefined ? { skipped: partial.skipped } : {}),
    ...(partial.proposedChangeSet !== undefined ? { proposedChangeSet: partial.proposedChangeSet } : {}),
    ...(partial.coverage !== undefined ? { coverage: partial.coverage } : {}),
  };
}

export function compoundResult(partial: CompoundResultPartial): string {
  return JSON.stringify(buildCompoundResult(partial));
}

export function parseCompoundResult(text: string): CompoundResult | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as CompoundResult).status !== 'string') {
      return undefined;
    }
    return parsed as CompoundResult;
  } catch {
    return undefined;
  }
}

export function compoundDiagnostics(items: FileDiagnostic[]): CompoundDiagnostic[] {
  return items.map((item) => ({
    file: item.path,
    line: item.line,
    severity: item.severity,
    message: item.message,
  }));
}
