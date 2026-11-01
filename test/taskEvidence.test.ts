import { describe, expect, it } from 'vitest';
import { buildTaskEvidencePack } from '../src/planner/taskEvidence';

describe('task evidence pack', () => {
  it('selects request-relevant nodes and verified relationships', () => {
    const stored = {
      version: 5,
      workspaceRoot: '/workspace',
      filesHash: 'hash',
      mermaid: 'flowchart TD',
      paths: { auth: 'src/auth.ts', app: 'src/app.ts' },
      model: 'local',
      generatedAt: Date.now(),
      coverage: {
        indexedFiles: 2,
        representedFiles: 2,
        unsupportedSourceFiles: 0,
        parseFailures: 0,
        oversizedSourceFiles: 0,
        scanLimitReached: false,
        unresolvedRelationships: 0,
      },
      structured: {
        nodes: [
          { id: 'project', label: 'Project' },
          { id: 'auth', label: 'Auth', group: 'Backend', path: 'src/auth.ts' },
          { id: 'app', label: 'App', group: 'Core', path: 'src/app.ts' },
        ],
        edges: [{ from: 'app', to: 'auth', label: 'imports', evidence: [{ path: 'src/app.ts', line: 2 }] }],
      },
    };
    const state = { get: <T>(_key: string): T | undefined => stored as T };
    const result = buildTaskEvidencePack(state, 'explain authentication', 2000, '/workspace');
    expect(result).toContain('src/auth.ts');
    expect(result).toContain('imports');
    expect(result).toContain('verify with tools');
  });

  it('rejects a cached map from another workspace', () => {
    const state = { get: <T>(_key: string): T | undefined => ({
      version: 5,
      workspaceRoot: '/other',
      filesHash: 'hash',
      mermaid: 'flowchart TD',
      paths: {},
      model: 'local',
      generatedAt: Date.now(),
      coverage: { indexedFiles: 0, representedFiles: 0, unsupportedSourceFiles: 0, parseFailures: 0, oversizedSourceFiles: 0, scanLimitReached: false, unresolvedRelationships: 0 },
      structured: { nodes: [{ id: 'project', label: 'Project' }], edges: [] },
    } as T) };
    expect(buildTaskEvidencePack(state, 'anything', 1000, '/workspace')).toBeUndefined();
  });
});
