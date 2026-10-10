import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_MAP_KEY,
  architectureFilesHash,
  isStale,
  readStoredMap,
  writeStoredMap,
} from '../src/architecture/mapStore';
import type { StoredArchitectureMap } from '../src/architecture/mapStore';

class FakeMemento {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

const stored: StoredArchitectureMap = {
  version: 3,
  filesHash: architectureFilesHash(['src/a.ts', 'src/b.ts']),
  mermaid: 'flowchart TD\n  n1["App"]',
  paths: { n1: 'src/a.ts' },
  structured: {
    nodes: [
      { id: 'n1', label: 'App', path: 'src/a.ts' },
      { id: 'n2', label: 'Lib', path: 'src/b.ts' },
    ],
    edges: [{ from: 'n1', to: 'n2', label: 'calls' }],
  },
  model: 'test-model',
  generatedAt: 1700000000000,
  coverage: {
    indexedFiles: 2,
    representedFiles: 2,
    unsupportedSourceFiles: 0,
    parseFailures: 0,
    oversizedSourceFiles: 0,
    scanLimitReached: false,
    unresolvedRelationships: 0,
  },
};

describe('architectureFilesHash', () => {
  it('is stable across order and deduplicates', () => {
    expect(architectureFilesHash(['b', 'a', 'a'])).toBe(architectureFilesHash(['a', 'b']));
    expect(architectureFilesHash(['a'])).not.toBe(architectureFilesHash(['b']));
    expect(architectureFilesHash(['src/a.ts'])).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('map store', () => {
  it('round-trips through a Memento-like state', async () => {
    const state = new FakeMemento();
    await writeStoredMap(state, stored);

    expect(state.get(ARCHITECTURE_MAP_KEY)).toEqual(stored);
    expect(readStoredMap(state)).toEqual(stored);
  });

  it('reports staleness against the current hash', () => {
    expect(isStale(stored, stored.filesHash)).toBe(false);
    expect(isStale(stored, 'different')).toBe(true);
  });

  it('returns undefined when nothing is stored', () => {
    expect(readStoredMap(new FakeMemento())).toBeUndefined();
  });

  it('rejects malformed stored data', async () => {
    const state = new FakeMemento();

    await state.update(ARCHITECTURE_MAP_KEY, null);
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, 'nope');
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, { ...stored, version: 2 });
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, { ...stored, structured: undefined });
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, { ...stored, filesHash: 7 });
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, { ...stored, mermaid: null });
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, { ...stored, model: 42 });
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, { ...stored, generatedAt: 'now' });
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, { ...stored, generatedAt: Number.NaN });
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, { ...stored, paths: ['src/a.ts'] });
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, { ...stored, paths: { n1: 7 } });
    expect(readStoredMap(state)).toBeUndefined();

    await state.update(ARCHITECTURE_MAP_KEY, { ...stored, paths: undefined });
    expect(readStoredMap(state)).toBeUndefined();
  });
});
