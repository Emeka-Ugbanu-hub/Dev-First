import { parseCompoundResult } from './compoundResult';

const MAX_MODEL_DIFF_CHARS = 12_000;
const MAX_MODEL_RESULT_CHARS = 24_000;

/**
 * Keep the complete tool result for the UI and run accounting, but avoid
 * repeating verbose JSON and very large diffs in every subsequent model
 * prefill. Exact file content and ordinary text results are never rewritten.
 */
export function projectToolResultForModel(toolName: string, result: string): string {
  if (result.length <= 4_000) return result;

  const compound = parseCompoundResult(result);
  if (!compound) return result;

  const projected: Record<string, unknown> = {
    status: compound.status,
    verification: compound.verification,
    ...(compound.changedFiles !== undefined ? { changedFiles: compound.changedFiles } : {}),
    ...(compound.files.length > 0 && !samePaths(compound.files, compound.changedFiles)
      ? { files: compound.files }
      : {}),
    ...(compound.diagnostics?.length ? { diagnostics: compound.diagnostics } : {}),
    ...(compound.evidence?.length ? { evidence: compound.evidence } : {}),
    ...(compound.rollbackAvailable ? { rollbackAvailable: true } : {}),
    ...(compound.message ? { message: compound.message } : {}),
    ...(compound.truncated ? { truncated: true } : {}),
    ...(compound.skipped?.length ? { skipped: compound.skipped } : {}),
    ...(compound.coverage ? { coverage: compound.coverage } : {}),
    ...(compound.policyLevel !== undefined ? { policyLevel: compound.policyLevel } : {}),
    ...(compound.reasons?.length ? { reasons: compound.reasons } : {}),
    ...(compound.repairAllowed ? { repairAllowed: true } : {}),
  };

  if (compound.diff) {
    projected.diff = compactDiff(compound.diff);
  }
  if (compound.proposedChangeSet?.length) {
    projected.proposedChangeSet = compound.proposedChangeSet;
  }

  const json = JSON.stringify(projected);
  if (json.length <= MAX_MODEL_RESULT_CHARS) {
    return json;
  }

  // Preserve verification and file/status facts even when diagnostic/evidence
  // text is unusually large. The omission is explicit so the model can fetch
  // exact details again instead of treating a partial result as complete.
  const compact = {
    status: compound.status,
    verification: compound.verification,
    changedFiles: (compound.changedFiles ?? compound.files).slice(0, 30),
    ...(compound.message ? { message: capText(compound.message, 800) } : {}),
    ...(compound.diagnostics?.length ? {
      diagnostics: compound.diagnostics.slice(0, 12).map((entry) => ({
        file: capText(entry.file, 200),
        line: entry.line,
        severity: capText(entry.severity, 40),
        message: capText(entry.message, 400),
      })),
      omittedDiagnostics: Math.max(0, compound.diagnostics.length - 12),
    } : {}),
    ...(compound.evidence?.length ? {
      evidence: compound.evidence.slice(0, 10).map((entry) => ({
        kind: capText(entry.kind, 60),
        summary: capText(entry.summary, 400),
        ...(entry.file ? { file: capText(entry.file, 200) } : {}),
        ...(entry.line !== undefined ? { line: entry.line } : {}),
      })),
      omittedEvidence: Math.max(0, compound.evidence.length - 10),
    } : {}),
    ...(compound.diff ? { diff: compactDiff(compound.diff, 4_000) } : {}),
    ...(compound.proposedChangeSet?.length ? {
      proposedChangeSet: compound.proposedChangeSet.slice(0, 5).map((entry) => ({
        path: capText(entry.path, 200),
        ok: entry.ok,
        ...(entry.line !== undefined ? { line: entry.line } : {}),
        ...(entry.reason ? { reason: capText(entry.reason, 300) } : {}),
        ...(entry.oldText ? { oldText: capText(entry.oldText, 600) } : {}),
        ...(entry.newText ? { newText: capText(entry.newText, 600) } : {}),
      })),
      omittedProposedChanges: Math.max(0, compound.proposedChangeSet.length - 5),
    } : {}),
    note: `Projected from ${toolName} result to fit model context; read the affected files or rerun a focused inspection for omitted detail.`,
  };
  return JSON.stringify(compact);
}

function samePaths(left: string[], right: string[] | undefined): boolean {
  return Boolean(right && left.length === right.length && left.every((value, index) => value === right[index]));
}

function capText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [detail omitted; inspect the file for exact text]`;
}

function compactDiff(diff: string, limit = MAX_MODEL_DIFF_CHARS): string {
  if (diff.length <= limit) return diff;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${diff.slice(0, head)}\n… [diff middle omitted; inspect the affected file or request a focused diff] …\n${diff.slice(-tail)}`;
}
