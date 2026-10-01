import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../src/scan/duplication';
import {
  collectProjectModelSnapshot,
  formatProjectModelSection,
  parseProjectModelResponse,
  parseProjectModelRevalidation,
  parseProjectModelSection,
  projectModelStaleReason,
  relevantProjectModelBullets,
  updateProjectModelStaleness,
} from '../src/scan/projectModel';
import type { ProjectModelBullet, ProjectModelSnapshot } from '../src/scan/projectModel';

const A = 'file:///w/src/services/aService.ts';
const B = 'file:///w/src/services/bService.ts';
const C = 'file:///w/src/repos/cRepo.ts';
const NOW = Date.parse('2026-09-21T00:00:00.000Z');

function facts(file: string, overrides: Partial<FileFacts> = {}): FileFacts {
  return {
    file,
    imports: [],
    exports: [],
    handlers: [],
    constants: [],
    moduleCaches: [],
    listeners: [],
    storageKeys: [],
    functions: [],
    types: [],
    httpClients: [],
    httpCalls: [],
    scopedHttpClients: [],
    mutableState: [],
    stateWrites: [],
    sql: [],
    secrets: [],
    ...overrides,
  };
}

function importOf(specifier: string, line = 0) {
  return { specifier, names: [], line };
}

function bullet(overrides: Partial<ProjectModelBullet> = {}): ProjectModelBullet {
  return {
    statement: 'Services own the business logic.',
    file: A,
    line: 2,
    verifiedAt: NOW,
    ...overrides,
  };
}

function snapshot(files: FileFacts[], hashes: Record<string, string>): ProjectModelSnapshot {
  return collectProjectModelSnapshot(files, new Map(Object.entries(hashes)));
}

describe('collectProjectModelSnapshot', () => {
  it('captures hashes, layer files, and resolved import edges', () => {
    const files = [facts(A, { imports: [importOf('../repos/cRepo', 3)] }), facts(B), facts(C)];
    const result = snapshot(files, { [A]: 'h1', [B]: 'h2', [C]: 'h3' });
    expect(result.layerFiles).toEqual([A, B, C].sort());
    expect(result.edges).toEqual([`${A}\u0000${C}`]);
    expect(result.hashes[A]).toBe('h1');
  });
});

describe('updateProjectModelStaleness', () => {
  it('marks bullets stale when the evidence file changed', () => {
    const previous = snapshot([facts(A)], { [A]: 'h1' });
    const current = snapshot([facts(A)], { [A]: 'h2' });
    const result = updateProjectModelStaleness([bullet()], previous, current);
    expect(result.stale).toHaveLength(1);
    expect(result.bullets[0].stale).toBe(true);
    expect(result.reasons.get(result.stale[0])).toBe('evidence changed');
  });

  it('drops bullets whose evidence file is gone', () => {
    const previous = snapshot([facts(A)], { [A]: 'h1' });
    const current = snapshot([facts(B)], { [B]: 'h2' });
    const result = updateProjectModelStaleness([bullet()], previous, current);
    expect(result.bullets).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it('keeps bullets when nothing changed', () => {
    const previous = snapshot([facts(A)], { [A]: 'h1' });
    const current = snapshot([facts(A)], { [A]: 'h1' });
    const result = updateProjectModelStaleness([bullet()], previous, current);
    expect(result.stale).toEqual([]);
    expect(result.bullets[0].stale).toBeUndefined();
  });

  it('marks bullets stale when new files appear in the layer directory', () => {
    const previous = snapshot([facts(A), facts(C)], { [A]: 'h1', [C]: 'h2' });
    const current = snapshot([facts(A), facts(B), facts(C)], { [A]: 'h1', [B]: 'h3', [C]: 'h2' });
    const result = updateProjectModelStaleness([bullet()], previous, current);
    expect(result.stale).toHaveLength(1);
    expect(result.reasons.get(result.stale[0])).toBe('layer files changed');
  });

  it('marks bullets stale when the import edges around the evidence changed', () => {
    const previous = snapshot([facts(A), facts(C)], { [A]: 'h1', [C]: 'h2' });
    const current = snapshot([facts(A), facts(C)], { [A]: 'h1', [C]: 'h2' });
    previous.edges = [`${A}\u0000${C}`];
    current.edges = [];
    const result = updateProjectModelStaleness([bullet()], previous, current);
    expect(result.stale).toHaveLength(1);
    expect(result.reasons.get(result.stale[0])).toBe('imports changed');
  });

  it('treats bullets without a previous hash as unverified', () => {
    const previous = snapshot([], {});
    const current = snapshot([facts(A)], { [A]: 'h1' });
    const result = updateProjectModelStaleness([bullet()], previous, current);
    expect(result.reasons.get(result.stale[0])).toBe('unverified');
  });

  it('exposes a single-bullet reason helper', () => {
    const previous = snapshot([facts(A)], { [A]: 'h1' });
    const current = snapshot([facts(A)], { [A]: 'h2' });
    expect(projectModelStaleReason(bullet(), previous, current)).toBe('evidence changed');
  });
});

describe('relevantProjectModelBullets', () => {
  const bullets = [
    bullet({ statement: 'Handlers call the auth check before login business logic.', verifiedAt: NOW }),
    bullet({
      statement: 'Input validation lives in the service layer.',
      file: B,
      verifiedAt: NOW + 1000,
    }),
    bullet({ statement: 'Files use the Service suffix.', file: C, verifiedAt: NOW + 2000 }),
  ];

  it('filters by keyword overlap and ranks by score', () => {
    const relevant = relevantProjectModelBullets(bullets, 'add login validation to the form');
    expect(relevant.map((entry) => entry.file)).toEqual([B, A]);
  });

  it('returns nothing when there is no overlap', () => {
    expect(relevantProjectModelBullets(bullets, 'update the readme')).toEqual([]);
  });

  it('caps the number of bullets', () => {
    const many = Array.from({ length: 8 }, (_value, index) =>
      bullet({ statement: `Validation rule ${index} lives in services.`, verifiedAt: NOW + index }),
    );
    expect(relevantProjectModelBullets(many, 'validation rules', 5)).toHaveLength(5);
  });
});

describe('project model formatting', () => {
  it('marks stale bullets as may be outdated and round-trips', () => {
    const section = formatProjectModelSection([bullet({ stale: true })]);
    expect(section).toContain('(may be outdated)');
    const parsed = parseProjectModelSection(section);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].statement).toBe('Services own the business logic.');
    expect(parsed[0].file).toBe('aService.ts');
    expect(parsed[0].line).toBe(2);
    expect(parsed[0].stale).toBe(true);
    expect(parsed[0].verifiedAt).toBe(NOW);
  });
});

describe('parseProjectModelResponse', () => {
  it('resolves evidence files and rejects unknown ones', () => {
    const files = [facts(A), facts(C)];
    const raw = JSON.stringify({
      bullets: [
        { statement: 'Services call repositories directly.', file: 'src/services/aService.ts', line: 3 },
        { statement: 'Invented.', file: 'src/nowhere.ts', line: 1 },
      ],
    });
    const parsed = parseProjectModelResponse(raw, files, NOW);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].file).toBe(A);
    expect(parsed[0].line).toBe(2);
    expect(parsed[0].verifiedAt).toBe(NOW);
  });

  it('caps the number of bullets', () => {
    const files = [facts(A)];
    const entries = Array.from({ length: 14 }, (_value, index) => ({
      statement: `Statement ${index}`,
      file: 'src/services/aService.ts',
      line: index + 1,
    }));
    const parsed = parseProjectModelResponse(JSON.stringify({ bullets: entries }), files, NOW);
    expect(parsed).toHaveLength(10);
  });
});

describe('parseProjectModelRevalidation', () => {
  it('maps refreshed statements back to stale bullets', () => {
    const stale = [bullet(), bullet({ file: B, statement: 'Other.' })];
    const updates = parseProjectModelRevalidation(
      '{"bullets":[{"index":2,"statement":"Refreshed other.","line":9}]}',
      stale,
      NOW,
    );
    expect(updates?.size).toBe(1);
    expect(updates?.get(1)?.statement).toBe('Refreshed other.');
    expect(updates?.get(1)?.line).toBe(8);
    expect(updates?.get(1)?.verifiedAt).toBe(NOW);
  });

  it('rejects invalid output and out-of-range indices', () => {
    const stale = [bullet()];
    expect(parseProjectModelRevalidation('not json', stale)).toBeUndefined();
    expect(parseProjectModelRevalidation('{"bullets":[{"index":9,"statement":"X."}]}', stale)?.size).toBe(0);
  });
});
