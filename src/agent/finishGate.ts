export interface FinishGateInput {
  planSteps: string[];
  completedSteps: number[];
  skippedSteps: number[];
  skippedReasons?: Record<number, string>;
  todos: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'cancelled' }>;
  expectedFiles: Array<{ path: string; action: 'modify' | 'add' | 'delete' }>;
  changedFiles: Array<{ path: string; delivered: boolean }>;
  recentToolFailures: string[];
  newDiagnosticErrors: number;
  diagnosticsAvailable: boolean;
  verificationRan: string[];
  planRequiredCheck?: 'typecheck' | 'test' | 'lint' | 'build';
  baselinesAvailable?: boolean;
}

export type FinishGateResult = { ok: true } | { ok: false; issues: string[]; compact: string };

export function checkFinish(input: FinishGateInput): FinishGateResult {
  const steps = Array.isArray(input.planSteps) ? input.planSteps : [];
  const completed = new Set(input.completedSteps ?? []);
  const skipped = new Set(input.skippedSteps ?? []);
  const expected = input.expectedFiles ?? [];
  const changedList = input.changedFiles ?? [];
  const changed = new Map(changedList.map((file) => [file.path, file]));
  const issues: string[] = [];

  const unfinished: string[] = [];
  for (let index = 0; index < steps.length; index++) {
    if (completed.has(index) || skipped.has(index)) {
      continue;
    }
    unfinished.push(steps[index]);
    issues.push(`unfinished step: "${steps[index]}"`);
  }

  const inProgress: string[] = [];
  for (const todo of input.todos ?? []) {
    if (todo.status !== 'in_progress') {
      continue;
    }
    inProgress.push(todo.text);
    issues.push(`step still in progress: "${todo.text}"`);
  }

  const pendingMatches: string[] = [];
  const flagged = new Set(unfinished);
  for (const todo of input.todos ?? []) {
    if (todo.status !== 'pending') {
      continue;
    }
    const match = steps.find((step) => step.trim() === todo.text.trim());
    if (!match || flagged.has(match)) {
      continue;
    }
    flagged.add(match);
    pendingMatches.push(match);
    issues.push(`unfinished step: "${match}"`);
  }

  const missingFiles: string[] = [];
  for (const file of expected) {
    const entry = changed.get(file.path);
    if (!entry) {
      missingFiles.push(file.path);
      issues.push(`expected file not changed: ${file.path}`);
      continue;
    }
    if (file.action !== 'add' && !entry.delivered) {
      missingFiles.push(file.path);
      issues.push(`expected file not changed: ${file.path} (reverted)`);
    }
  }

  const failures = (input.recentToolFailures ?? []).slice(0, 2);
  for (const failure of failures) {
    issues.push(`recent tool failure: ${failure}`);
  }

  const newErrors = input.newDiagnosticErrors ?? 0;
  const diagnosticsIssue = Boolean(input.diagnosticsAvailable) && newErrors > 0;
  if (diagnosticsIssue) {
    issues.push(`${newErrors} new diagnostic error${newErrors === 1 ? '' : 's'}`);
  }

  const requiredKind = input.planRequiredCheck;
  const verificationRan = input.verificationRan ?? [];
  const requiredRan = requiredKind
    ? verificationRan.some((entry) => entry === requiredKind || entry.startsWith(`${requiredKind}:`))
    : true;
  const requiredCommand = requiredKind
    ? verificationRan.find((entry) => entry.startsWith(`${requiredKind}:`))?.slice(requiredKind.length + 1)
    : undefined;
  if (requiredKind && !requiredRan) {
    issues.push(`required verification not run: ${requiredKind}`);
  }

  if (issues.length === 0) {
    return { ok: true };
  }

  const completedCount = steps.filter((_step, index) => completed.has(index)).length;
  const reasonEntries = (input.skippedSteps ?? [])
    .map((index) => ({ text: steps[index] ?? '', reason: input.skippedReasons?.[index] }))
    .filter((entry) => entry.reason);
  const skippedText = reasonEntries
    .map((entry) => ` · Skipped: "${entry.text}" (reason: ${entry.reason})`)
    .join('');
  const pendingText = unfinished.length > 0 ? unfinished[0] : 'none';
  const planLine = `Plan steps: ${steps.length} · Completed: ${completedCount} · Pending: ${pendingText}${skippedText}`;

  const deliveredCount = changedList.filter((file) => file.delivered).length;
  const baselines =
    input.baselinesAvailable ?? !(changedList.length === 0 && expected.length > 0);
  const changedLine = baselines
    ? `Changed files: ${deliveredCount} (delivered)`
    : `Changed files: ${changedList.length} changed (baseline unavailable)`;

  const diagnosticsLine = input.diagnosticsAvailable
    ? `Diagnostics: ${newErrors} new error${newErrors === 1 ? '' : 's'}`
    : 'Diagnostics: unavailable (no provider)';

  const ranSummary =
    verificationRan.length === 0
      ? 'none ran'
      : `${verificationRan.slice(0, 3).join(', ')}${verificationRan.length > 3 ? ` +${verificationRan.length - 3}` : ''}`;
  const verificationLine = `Verification: ${ranSummary}${requiredKind ? ` · required: ${requiredKind}` : ''}`;

  let action: string;
  if (unfinished.length > 0) {
    action = `finish step: "${unfinished[0]}"`;
  } else if (inProgress.length > 0) {
    action = `finish step: "${inProgress[0]}"`;
  } else if (pendingMatches.length > 0) {
    action = `finish step: "${pendingMatches[0]}"`;
  } else if (missingFiles.length > 0) {
    action = `complete expected file: ${missingFiles[0]}`;
  } else if (failures.length > 0) {
    action = `resolve recent tool failure: ${failures[0]}`;
  } else if (diagnosticsIssue) {
    action = `fix ${newErrors} new diagnostic error${newErrors === 1 ? '' : 's'}`;
  } else if (requiredKind && !requiredRan) {
    action = requiredCommand
      ? `run required ${requiredKind} check: ${requiredCommand}`
      : `run the required ${requiredKind} check`;
  } else {
    action = 'call finish again when the remaining work is complete';
  }

  const lines = [
    'Finish check:',
    planLine,
    changedLine,
    diagnosticsLine,
    verificationLine,
    `Action required: ${action}`,
  ];
  return { ok: false, issues, compact: lines.slice(0, 8).join('\n') };
}
