import { createHash } from 'node:crypto';
import type { MapPaths } from './mapValidate';

export interface StoredArchitectureMap {
  version: 1;
  filesHash: string;
  mermaid: string;
  paths: MapPaths;
  model: string;
  generatedAt: number;
}

export const ARCHITECTURE_MAP_KEY = 'devFirst.architectureMap';

export function architectureFilesHash(files: string[]): string {
  const unique = [...new Set(files)].sort();
  return createHash('sha1').update(unique.join('\n')).digest('hex');
}

export function readStoredMap(state: {
  get<T>(key: string): T | undefined;
}): StoredArchitectureMap | undefined {
  const stored = state.get<unknown>(ARCHITECTURE_MAP_KEY);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return undefined;
  }
  const candidate = stored as Partial<StoredArchitectureMap> & { paths?: unknown };
  if (candidate.version !== 1) {
    return undefined;
  }
  if (
    typeof candidate.filesHash !== 'string' ||
    typeof candidate.mermaid !== 'string' ||
    typeof candidate.model !== 'string' ||
    typeof candidate.generatedAt !== 'number' ||
    !Number.isFinite(candidate.generatedAt)
  ) {
    return undefined;
  }
  const paths = candidate.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    return undefined;
  }
  const clean: MapPaths = {};
  for (const [nodeId, value] of Object.entries(paths as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      return undefined;
    }
    clean[nodeId] = value;
  }
  return {
    version: 1,
    filesHash: candidate.filesHash,
    mermaid: candidate.mermaid,
    paths: clean,
    model: candidate.model,
    generatedAt: candidate.generatedAt,
  };
}

export async function writeStoredMap(
  state: { update(key: string, value: unknown): Thenable<void> },
  map: StoredArchitectureMap,
): Promise<void> {
  await state.update(ARCHITECTURE_MAP_KEY, map);
}

export function isStale(stored: StoredArchitectureMap, currentHash: string): boolean {
  return stored.filesHash !== currentHash;
}
