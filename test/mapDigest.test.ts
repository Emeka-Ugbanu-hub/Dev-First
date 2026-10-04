import { describe, expect, it } from 'vitest';
import type {
  FileFacts,
  HandlerRecord,
  ImportRecord,
  SqlRecord,
} from '../src/scan/duplication';
import { buildMapDigest } from '../src/architecture/mapDigest';

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

function handler(name: string, method: string, pathShape = ''): HandlerRecord {
  return { name, line: 0, hasAuth: false, hasValidation: false, method, pathShape };
}

function importRecord(specifier: string): ImportRecord {
  return { specifier, names: [], line: 0 };
}

function sqlRecord(line: number): SqlRecord {
  return { line, parameterized: true, concatenated: false };
}

describe('buildMapDigest', () => {
  it('aggregates the folder tree by directory with parent totals', () => {
    const digest = buildMapDigest(
      [
        facts('file:///repo/src/index.ts'),
        facts('file:///repo/src/components/Button.tsx'),
        facts('file:///repo/src/components/Card.tsx'),
        facts('file:///repo/src/utils/format.ts'),
        facts('file:///repo/package.json'),
      ],
      '/repo',
    );

    expect(digest).toContain('Workspace: repo');
    expect(digest).toContain('Indexed files: 5');
    expect(digest).toContain('Folder tree (folders only, files per folder):');
    expect(digest).toContain('- src/ (4)');
    expect(digest).toContain('- src/components/ (2)');
    expect(digest).toContain('- src/utils/ (1)');
    expect(digest).toContain('- ./ (1)');
    expect(digest).not.toContain('Button.tsx');
    expect(digest).not.toContain('Card.tsx');
  });

  it('stops folder aggregation at depth 3', () => {
    const digest = buildMapDigest([facts('file:///repo/a/b/c/d/thing.ts')], '/repo');
    expect(digest).toContain('- a/ (1)');
    expect(digest).toContain('- a/b/ (1)');
    expect(digest).toContain('- a/b/c/ (1)');
    expect(digest).not.toContain('- a/b/c/d/');
  });

  it('lists manifests at any depth and entry files only at depth <= 2', () => {
    const digest = buildMapDigest(
      [
        facts('file:///repo/package.json'),
        facts('file:///repo/src-tauri/Cargo.toml'),
        facts('file:///repo/src/index.ts'),
        facts('file:///repo/src/main.rs'),
        facts('file:///repo/src/feature/deep/main.ts'),
      ],
      '/repo',
    );

    expect(digest).toContain('Key files:');
    expect(digest).toContain('- package.json');
    expect(digest).toContain('- src-tauri/Cargo.toml');
    expect(digest).toContain('- src/index.ts');
    expect(digest).toContain('- src/main.rs');
    expect(digest).not.toContain('- src/feature/deep/main.ts');
  });

  it('builds entry, route, IPC, database, and external signal lines', () => {
    const digest = buildMapDigest(
      [
        facts('file:///repo/src/main.ts'),
        facts('file:///repo/src/routes.ts', {
          handlers: [
            handler('listUsers', 'GET', '/users'),
            handler('createUser', 'POST', '/users'),
            handler('greet', 'IPC'),
          ],
          tauriCommandRegistrations: [{ name: 'save_file', line: 0 }],
        }),
        facts('file:///repo/src/db.ts', { sql: [sqlRecord(1), sqlRecord(2)] }),
        facts('file:///repo/src/orm.ts', { imports: [importRecord('sqlx')] }),
        facts('file:///repo/src/api.rs', { imports: [importRecord('reqwest::Client')] }),
        facts('file:///repo/src/client.ts', {
          httpClients: [{ name: 'api', line: 0, kind: 'axios', config: '' }],
        }),
      ],
      '/repo',
    );

    expect(digest).toContain('- Entry points: src/main.ts');
    expect(digest).toContain('- Routes: GET /users -> src/routes.ts');
    expect(digest).toContain('- Routes: POST /users -> src/routes.ts');
    expect(digest).toContain('- IPC commands: greet, save_file (2)');
    expect(digest).toContain('- Database: src/db.ts (2 queries)');
    expect(digest).toContain('- Database: src/orm.ts (0 queries)');
    expect(digest).toContain('- External clients: src/api.rs');
    expect(digest).toContain('- External clients: src/client.ts');
    expect(digest).toContain('- Workers/queues: none detected');
  });

  it('caps each signal list', () => {
    const manyRoutes = Array.from({ length: 25 }, (_value, index) =>
      facts(`file:///repo/src/h${index}.ts`, {
        handlers: [handler(`h${index}`, 'GET', `/r${index}`)],
      }),
    );
    const routeDigest = buildMapDigest(manyRoutes, '/repo');
    const routeLines = routeDigest
      .split('\n')
      .filter((line) => line.startsWith('- Routes:'));
    expect(routeLines).toHaveLength(20);

    const manyDatabases = Array.from({ length: 15 }, (_value, index) =>
      facts(`file:///repo/src/db${index}.ts`, { sql: [sqlRecord(1)] }),
    );
    const dbDigest = buildMapDigest(manyDatabases, '/repo');
    const dbLines = dbDigest.split('\n').filter((line) => line.startsWith('- Database:'));
    expect(dbLines).toHaveLength(10);

    const manyExternals = Array.from({ length: 15 }, (_value, index) =>
      facts(`file:///repo/src/external${index}.ts`, {
        imports: [importRecord('@supabase/supabase-js')],
      }),
    );
    const externalDigest = buildMapDigest(manyExternals, '/repo');
    const externalLines = externalDigest
      .split('\n')
      .filter((line) => line.startsWith('- External clients:'));
    expect(externalLines).toHaveLength(10);
  });

  it('caps the total digest length', () => {
    const many = Array.from({ length: 300 }, (_value, index) =>
      facts(`file:///repo/packages/pkg${index}/${'x'.repeat(60)}/file${index}.ts`),
    );
    const digest = buildMapDigest(many, '/repo');
    expect(digest.length).toBeLessThanOrEqual(6000);
    expect(digest.length).toBeGreaterThan(4000);
  });
});
