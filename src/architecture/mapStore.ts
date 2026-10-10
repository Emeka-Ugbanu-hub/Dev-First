import { createHash } from 'node:crypto';
import type { MapPaths, StructuredMap } from './mapValidate';
import type { ArchitectureScanCoverage } from '../scan/duplication';

export interface ArchitectureMapCoverage extends ArchitectureScanCoverage {
  indexedFiles: number;
  representedFiles: number;
  unresolvedRelationships: number;
}

export interface StoredArchitectureMap {
  version: 3;
  filesHash: string;
  mermaid: string;
  paths: MapPaths;
  structured: StructuredMap;
  model: string;
  generatedAt: number;
  coverage: ArchitectureMapCoverage;
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
  if (candidate.version !== 3) {
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
  const structured = candidate.structured as unknown;
  const coverage = candidate.coverage as Partial<ArchitectureMapCoverage> | undefined;
  if (!coverage || typeof coverage !== 'object') {
    return undefined;
  }
  const coverageNumbers = ['indexedFiles', 'representedFiles', 'unsupportedSourceFiles', 'parseFailures', 'oversizedSourceFiles', 'unresolvedRelationships'] as const;
  if (coverageNumbers.some((key) => typeof coverage[key] !== 'number' || !Number.isFinite(coverage[key]))) {
    return undefined;
  }
  if (typeof coverage.scanLimitReached !== 'boolean') {
    return undefined;
  }
  if (!structured || typeof structured !== 'object') {
    return undefined;
  }
  const nodes = (structured as { nodes?: unknown }).nodes;
  const edges = (structured as { edges?: unknown }).edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return undefined;
  }
  return {
    version: 3,
    filesHash: candidate.filesHash,
    mermaid: candidate.mermaid,
    paths: clean,
    structured: structured as StructuredMap,
    model: candidate.model,
    generatedAt: candidate.generatedAt,
    coverage: {
      indexedFiles: coverage.indexedFiles as number,
      representedFiles: coverage.representedFiles as number,
      unsupportedSourceFiles: coverage.unsupportedSourceFiles as number,
      parseFailures: coverage.parseFailures as number,
      oversizedSourceFiles: coverage.oversizedSourceFiles as number,
      scanLimitReached: coverage.scanLimitReached,
      unresolvedRelationships: coverage.unresolvedRelationships as number,
    },
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
