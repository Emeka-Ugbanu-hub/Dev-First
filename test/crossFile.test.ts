import { afterAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  window: {
    withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
  },
}));

import { TreeSitterService } from '../src/scan/treeSitter';
import { profileFor } from '../src/scan/languages/profiles';
import { DuplicationIndex, extractFileFacts } from '../src/scan/duplication';
import type {
  FileFacts,
  FunctionRecord,
  HandlerRecord,
  HttpClientRecord,
  TypeRecord,
} from '../src/scan/duplication';
import {
  findCircularImports,
  findCoverageAsymmetry,
  findDeadExports,
  findDeepImportChains,
  findDivergentConstants,
  findDuplicateHttpClients,
  findDuplicatedSecretsAcrossFiles,
  findDuplicateStateStores,
  findDuplicateTypeDefinitions,
  findEndpointMismatch,
  findEnumDrift,
  findGodModules,
  findInterfaceImplementationDrift,
  findListenerLeaks,
  findMissingSiblingAuth,
  findMissingSiblingValidation,
  findMixedAsyncPatterns,
  findNamingDrift,
  findOrphanedFiles,
  findOrphanedStorageKeys,
  findOrphanedTests,
  findPoolingInconsistency,
  findSharedMutableState,
  findSignatureDrift,
  findSqlTwinInconsistency,
  findStaleFeatureFlags,
  findTtlDrift,
  findUnboundedCaches,
  findUnstableDependencies,
  parseShotgunLog,
  resolveSpecifier,
} from '../src/scan/crossFile';

const service = new TreeSitterService({ extensionUri: { fsPath: path.join(__dirname, '..') } });

afterAll(() => service.dispose());

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

function importOf(specifier: string, names: string[] = [], line = 0) {
  return { specifier, names, line };
}

function exportOf(name: string, line = 0, isDefault = false) {
  return { name, line, isDefault };
}

function fn(name: string, line = 0, overrides: Partial<FunctionRecord> = {}): FunctionRecord {
  return {
    name,
    line,
    paramCount: 0,
    params: [],
    exported: true,
    async: false,
    callbackStyle: false,
    promiseStyle: false,
    ...overrides,
  };
}

function typeDecl(
  name: string,
  kind: TypeRecord['kind'],
  line = 0,
  overrides: Partial<TypeRecord> = {},
): TypeRecord {
  return {
    name,
    kind,
    line,
    exported: true,
    methods: [],
    implements: [],
    members: [],
    ...overrides,
  };
}

function cacheOf(
  name: string,
  kind: 'map' | 'set' | 'array' | 'object' = 'map',
  line = 0,
  evicted = false,
) {
  return { name, kind, line, evicted };
}

function listenerOf(event: string, line = 0, kind: 'add' | 'remove' = 'add', literal = true) {
  return { event, line, kind, literal };
}

function httpCallOf(method: string, path: string, line = 0) {
  const pathShape = path
    .replace(/\{[^}]+\}/g, ':p')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p')
    .replace(/\/\d+(?=\/|$)/g, '/:n');
  return { method, path, pathShape, line };
}

function clientOf(name: string, kind: string, config: string, line = 0): HttpClientRecord {
  return { name, kind, config, line };
}

function handlerOf(name: string, overrides: Partial<HandlerRecord> = {}): HandlerRecord {
  return {
    name,
    line: 0,
    hasAuth: false,
    hasValidation: false,
    method: '',
    pathShape: '',
    ...overrides,
  };
}

async function extract(source: string) {
  const tree = await service.parse(source, 'typescript');
  const profile = profileFor('typescript');
  return extractFileFacts(tree!, source, profile!);
}

describe('cross-file extraction helpers', () => {
  it('extracts module specifiers and imported names', async () => {
    const source = [
      "import defaultThing, { alpha, beta as gamma } from './mod';",
      "import * as ns from '../pkg';",
      "const legacy = require('./legacy');",
      "export { alpha as delta } from './reexport';",
    ].join('\n');
    const result = await extract(source);
    expect(result.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ specifier: './mod', names: ['default', 'alpha', 'gamma'] }),
        expect.objectContaining({ specifier: '../pkg', names: ['*'] }),
        expect.objectContaining({ specifier: './legacy', names: [] }),
        expect.objectContaining({ specifier: './reexport', names: ['delta'] }),
      ]),
    );
  });

  it('extracts exported names and default exports', async () => {
    const source = [
      'export const one = 1, two = 2;',
      'export function three() {}',
      'export default function four() {}',
      "export { five as six } from './other';",
    ].join('\n');
    const result = await extract(source);
    expect(result.exports.map((record) => record.name).sort()).toEqual([
      'default',
      'one',
      'six',
      'three',
      'two',
    ]);
    expect(result.exports.find((record) => record.name === 'default')?.isDefault).toBe(true);
  });

  it('extracts handler-looking functions with auth and validation flags', async () => {
    const source = [
      'export function handleLogin(req, res) {',
      '  const token = verifyToken(req);',
      '  const body = loginSchema.parse(req.body);',
      '  res.json(body);',
      '}',
      'function formatName(value) { return value; }',
    ].join('\n');
    const result = await extract(source);
    expect(result.handlers).toEqual([
      {
        name: 'handleLogin',
        line: 0,
        hasAuth: true,
        hasValidation: true,
        method: '',
        pathShape: '',
      },
    ]);
  });

  it('extracts only mutated top-level module caches', async () => {
    const source = [
      'const cache = new Map();',
      'const tags = new Set();',
      'const items = [];',
      'const meta = {};',
      'const frozen = new Map();',
      'function remember(key, value) {',
      '  cache.set(key, value);',
      '  tags.add(value);',
      '  items.push(value);',
      '  meta[key] = value;',
      '}',
    ].join('\n');
    const result = await extract(source);
    expect(result.moduleCaches.map((record) => `${record.name}:${record.kind}`).sort()).toEqual([
      'cache:map',
      'items:array',
      'meta:object',
      'tags:set',
    ]);
  });

  it('extracts listener registrations', async () => {
    const source = [
      "window.addEventListener('resize', onResize);",
      "emitter.on('data', handleData);",
      "store.subscribe('updates', handler);",
    ].join('\n');
    const result = await extract(source);
    expect(result.listeners.map((record) => record.event)).toEqual(['resize', 'data', 'updates']);
  });

  it('extracts storage key reads and writes', async () => {
    const source = [
      "const saved = localStorage.getItem('theme');",
      "localStorage.setItem('theme', 'dark');",
      "context.globalState.update('devFirst.token', token);",
    ].join('\n');
    const result = await extract(source);
    expect(result.storageKeys).toEqual([
      { key: 'theme', access: 'read', line: 0 },
      { key: 'theme', access: 'write', line: 1 },
      { key: 'devFirst.token', access: 'write', line: 2 },
    ]);
  });

  it('extracts function signatures, async style, and return hints', async () => {
    const source = [
      'export function getUser(id: string): User {',
      '  return db.get(id);',
      '}',
      'export const fetchUser = async (id: string) => {',
      '  const response = await client.get(id);',
      '  return response;',
      '};',
      'const legacyHandler = function (err, res) {',
      '  res.send(err);',
      '};',
      'function onData(err, res) {',
      '  res.end();',
      '}',
    ].join('\n');
    const result = await extract(source);
    expect(result.functions).toEqual([
      {
        name: 'getUser',
        line: 0,
        paramCount: 1,
        params: ['id'],
        exported: true,
        async: false,
        callbackStyle: false,
        promiseStyle: false,
        returnHint: ': User',
      },
      {
        name: 'fetchUser',
        line: 3,
        paramCount: 1,
        params: ['id'],
        exported: true,
        async: true,
        callbackStyle: false,
        promiseStyle: true,
      },
      {
        name: 'legacyHandler',
        line: 7,
        paramCount: 2,
        params: ['err', 'res'],
        exported: false,
        async: false,
        callbackStyle: true,
        promiseStyle: false,
      },
      {
        name: 'onData',
        line: 10,
        paramCount: 2,
        params: ['err', 'res'],
        exported: false,
        async: false,
        callbackStyle: true,
        promiseStyle: false,
      },
    ]);
  });

  it('extracts interface, class, and type declarations with methods and implements', async () => {
    const source = [
      'export interface UserServiceContract {',
      '  findUser(id: string): Promise<User>;',
      '  saveUser(user: User): void;',
      '}',
      'export class UserServiceImpl implements UserServiceContract {',
      '  findUser(id: string) { return id; }',
      '}',
      'class PartialImpl implements UserServiceContract {',
      '  saveUser(user) { return user; }',
      '}',
      'export type UserId = string;',
    ].join('\n');
    const result = await extract(source);
    expect(result.types).toEqual([
      {
        name: 'UserServiceContract',
        kind: 'interface',
        line: 0,
        exported: true,
        methods: ['findUser', 'saveUser'],
        implements: [],
        members: [],
      },
      {
        name: 'UserServiceImpl',
        kind: 'class',
        line: 4,
        exported: true,
        methods: ['findUser'],
        implements: ['UserServiceContract'],
        members: [],
      },
      {
        name: 'PartialImpl',
        kind: 'class',
        line: 7,
        exported: false,
        methods: ['saveUser'],
        implements: ['UserServiceContract'],
        members: [],
      },
      {
        name: 'UserId',
        kind: 'type',
        line: 10,
        exported: true,
        methods: [],
        implements: [],
        members: [],
      },
    ]);
  });

  it('extracts handler method and normalized path shape', async () => {
    const source = [
      'export function handleGetUser(req, res) {',
      "  const route = '/users/:id';",
      '  res.json(route);',
      '}',
      'export function handlePostUser(req, res) {',
      "  const route = '/users';",
      '  res.json(route);',
      '}',
    ].join('\n');
    const result = await extract(source);
    expect(result.handlers).toEqual([
      {
        name: 'handleGetUser',
        line: 0,
        hasAuth: false,
        hasValidation: false,
        method: 'GET',
        pathShape: '/users/:p',
      },
      {
        name: 'handlePostUser',
        line: 4,
        hasAuth: false,
        hasValidation: false,
        method: 'POST',
        pathShape: '/users',
      },
    ]);
  });

  it('extracts top-level http clients with their configuration', async () => {
    const source = [
      "import axios from 'axios';",
      "export const api = axios.create({ baseURL: 'https://api.example.com', timeout: 5000 });",
      'export const legacy = (url) => fetch(url);',
    ].join('\n');
    const result = await extract(source);
    expect(result.httpClients.map((record) => `${record.name}:${record.kind}`)).toEqual([
      'api:axios',
      'legacy:fetch',
    ]);
    expect(result.httpClients[0].config).toContain('https://api.example.com');
  });

  it('extracts parameterized and concatenated sql usage', async () => {
    const source = [
      'export function findUser(id) {',
      "  return db.query('SELECT * FROM users WHERE id = ?', [id]);",
      '}',
      'export function searchUser(name) {',
      "  return db.query('SELECT * FROM users WHERE name = ' + name);",
      '}',
      'export function listUsers() {',
      "  return db.query('SELECT * FROM users');",
      '}',
    ].join('\n');
    const result = await extract(source);
    expect(result.sql).toEqual([
      { line: 1, parameterized: true, concatenated: false },
      { line: 4, parameterized: false, concatenated: true },
    ]);
  });

  it('extracts secret literals with their line', async () => {
    const source = [
      'const config = {',
      "  apiKey: 'sk_live_abcdefghijklmnop1234',",
      '};',
    ].join('\n');
    const result = await extract(source);
    expect(result.secrets).toEqual(
      expect.arrayContaining([
        {
          value: 'sk_live_abcdefghijklmnop1234',
          line: 1,
          ruleId: 'scan-any-stripe-key',
        },
      ]),
    );
    expect(result.secrets.every((record) => record.line === 1)).toBe(true);
  });
});

describe('findCircularImports', () => {
  it('detects a two-node cycle once per participating file', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', { imports: [importOf('./b', ['b'])], exports: [exportOf('a')] }),
        facts('file:///workspace/b.ts', { imports: [importOf('./a', ['a'])], exports: [exportOf('b')] }),
      ],
    };
    const findings = findCircularImports(index);
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((finding) => finding.file))).toEqual(
      new Set(['file:///workspace/a.ts', 'file:///workspace/b.ts']),
    );
    expect(
      findings.every(
        (finding) =>
          finding.ruleId === 'xf-circular-imports' &&
          finding.category === 'bug' &&
          finding.severity === 'warning',
      ),
    ).toBe(true);
    expect(findings[0].related).toHaveLength(1);
  });

  it('detects a three-node cycle', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', { imports: [importOf('./b', ['b'])] }),
        facts('file:///workspace/b.ts', { imports: [importOf('./c', ['c'])] }),
        facts('file:///workspace/c.ts', { imports: [importOf('./a', ['a'])] }),
      ],
    };
    expect(findCircularImports(index)).toHaveLength(3);
  });

  it('does not report a DAG', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          imports: [importOf('./b', ['b']), importOf('./c', ['c'])],
        }),
        facts('file:///workspace/b.ts', { imports: [importOf('./d', ['d'])] }),
        facts('file:///workspace/c.ts', { imports: [importOf('./d', ['d'])] }),
        facts('file:///workspace/d.ts', {}),
      ],
    };
    expect(findCircularImports(index)).toEqual([]);
  });
});

describe('findGodModules', () => {
  const target = facts('file:///workspace/t.ts', { exports: [exportOf('t')] });

  it('reports a file imported by more than the threshold', () => {
    const importers = Array.from({ length: 16 }, (_value, index) =>
      facts(`file:///workspace/m${index}.ts`, { imports: [importOf('./t')] }),
    );
    const findings = findGodModules({ files: [target, ...importers] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: 'xf-god-modules', file: target.file });
  });

  it('stays quiet at the threshold', () => {
    const importers = Array.from({ length: 15 }, (_value, index) =>
      facts(`file:///workspace/m${index}.ts`, { imports: [importOf('./t')] }),
    );
    expect(findGodModules({ files: [target, ...importers] })).toEqual([]);
  });
});

describe('findDeepImportChains', () => {
  it('reports chains longer than the depth', () => {
    const files = Array.from({ length: 9 }, (_value, index) =>
      facts(`file:///workspace/chain/a${index}.ts`, {
        imports: index < 8 ? [importOf(`./a${index + 1}`)] : [],
      }),
    );
    const findings = findDeepImportChains({ files });
    expect(findings.some((finding) => finding.file === 'file:///workspace/chain/a0.ts')).toBe(true);
    expect(findings.every((finding) => finding.ruleId === 'xf-deep-import-chains')).toBe(true);
  });

  it('stays quiet on short chains', () => {
    const files = [
      facts('file:///workspace/chain/a.ts', { imports: [importOf('./b')] }),
      facts('file:///workspace/chain/b.ts', { imports: [importOf('./c')] }),
      facts('file:///workspace/chain/c.ts', {}),
    ];
    expect(findDeepImportChains({ files })).toEqual([]);
  });
});

describe('findUnstableDependencies', () => {
  it('reports a high fan-out file imported by a stable one', () => {
    const dependencies = Array.from({ length: 9 }, (_value, index) =>
      facts(`file:///workspace/d${index}.ts`),
    );
    const hub = facts('file:///workspace/hub.ts', {
      imports: Array.from({ length: 9 }, (_value, index) => importOf(`./d${index}`)),
    });
    const stable = facts('file:///workspace/stable.ts', { imports: [importOf('./hub')] });
    const findings = findUnstableDependencies({ files: [hub, stable, ...dependencies] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-unstable-dependencies',
      file: 'file:///workspace/hub.ts',
    });
  });
});

describe('findOrphanedFiles', () => {
  it('reports unimported files but skips entry points and files without exports', () => {
    const index = {
      files: [
        facts('file:///workspace/src/thing.ts', {
          exports: [exportOf('a'), exportOf('b'), exportOf('c')],
        }),
        facts('file:///workspace/src/index.ts', { exports: [exportOf('main')] }),
        facts('file:///workspace/src/empty.ts'),
      ],
    };
    const findings = findOrphanedFiles(index);
    expect(findings.map((finding) => finding.file)).toEqual(['file:///workspace/src/thing.ts']);
  });

  it('does not report imported files', () => {
    const index = {
      files: [
        facts('file:///workspace/src/used.ts', {
          exports: [exportOf('a'), exportOf('b'), exportOf('c')],
        }),
        facts('file:///workspace/src/entry.ts', { imports: [importOf('./used')] }),
      ],
    };
    expect(findOrphanedFiles(index)).toEqual([]);
  });
});

describe('findDeadExports', () => {
  it('reports unused exports and skips used, default, and private names', () => {
    const index = {
      files: [
        facts('file:///workspace/src/lib.ts', {
          exports: [
            exportOf('used', 1),
            exportOf('deadOne', 2),
            exportOf('deadTwo', 3),
            exportOf('_hidden', 4),
            exportOf('default', 5, true),
          ],
        }),
        facts('file:///workspace/src/user.ts', { imports: [importOf('./lib', ['used'])] }),
      ],
    };
    const findings = findDeadExports(index);
    expect(findings.map((finding) => finding.message)).toEqual([
      'Export "deadOne" is never imported',
      'Export "deadTwo" is never imported',
    ]);
  });
});

describe('findOrphanedTests', () => {
  it('reports a test whose source file is missing', () => {
    const index = {
      files: [
        facts('file:///workspace/src/foo.ts', { exports: [exportOf('foo')] }),
        facts('file:///workspace/src/foo.test.ts'),
        facts('file:///workspace/src/bar.test.ts'),
      ],
    };
    expect(findOrphanedTests(index).map((finding) => finding.file)).toEqual([
      'file:///workspace/src/bar.test.ts',
    ]);
  });
});

describe('findCoverageAsymmetry', () => {
  it('reports untested siblings in a group of three or more', () => {
    const index = {
      files: [
        facts('file:///workspace/src/userService.ts', { exports: [exportOf('service')] }),
        facts('file:///workspace/src/userStore.ts', { exports: [exportOf('store')] }),
        facts('file:///workspace/src/userRepo.ts', { exports: [exportOf('repo')] }),
        facts('file:///workspace/src/userService.test.ts'),
      ],
    };
    const findings = findCoverageAsymmetry(index);
    expect(findings.map((finding) => finding.file)).toEqual([
      'file:///workspace/src/userRepo.ts',
      'file:///workspace/src/userStore.ts',
    ]);
    expect(findings[0].related.map((related) => related.file)).toEqual([
      'file:///workspace/src/userService.ts',
    ]);
  });
});

describe('findStaleFeatureFlags', () => {
  it('reports a flag referenced in a single file', () => {
    const files: FileFacts[] = [
      facts('file:///workspace/f0.ts', {
        constants: [
          { name: 'FEATURE_NEW_UI', value: 'true', line: 1 },
          { name: 'isBetaEnabled', value: 'true', line: 2 },
        ],
      }),
      facts('file:///workspace/f1.ts', {
        constants: [{ name: 'isBetaEnabled', value: 'true', line: 1 }],
      }),
    ];
    for (let index = 2; index < 20; index++) {
      files.push(facts(`file:///workspace/f${index}.ts`));
    }
    const findings = findStaleFeatureFlags({ files });
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('FEATURE_NEW_UI');
  });

  it('stays quiet with fewer than twenty indexed files', () => {
    const files: FileFacts[] = [
      facts('file:///workspace/f0.ts', {
        constants: [{ name: 'FEATURE_NEW_UI', value: 'true', line: 1 }],
      }),
    ];
    for (let index = 1; index < 19; index++) {
      files.push(facts(`file:///workspace/f${index}.ts`));
    }
    expect(findStaleFeatureFlags({ files })).toEqual([]);
  });
});

describe('findSignatureDrift', () => {
  it('reports exported functions with different parameter counts', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          functions: [fn('getUser', 3, { paramCount: 1, params: ['id'] })],
        }),
        facts('file:///workspace/b.ts', {
          functions: [fn('getUser', 7, { paramCount: 2, params: ['id', 'options'] })],
        }),
      ],
    };
    const findings = findSignatureDrift(index);
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.ruleId === 'xf-signature-drift')).toBe(true);
    expect(findings[0]).toMatchObject({
      category: 'smell',
      severity: 'info',
      file: 'file:///workspace/a.ts',
      line: 3,
    });
    expect(findings[0].related[0]).toMatchObject({
      file: 'file:///workspace/b.ts',
      line: 7,
    });
  });

  it('stays quiet when signatures match', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          functions: [fn('getUser', 3, { paramCount: 1, params: ['id'] })],
        }),
        facts('file:///workspace/b.ts', {
          functions: [fn('getUser', 9, { paramCount: 1, params: ['id'] })],
        }),
      ],
    };
    expect(findSignatureDrift(index)).toEqual([]);
  });
});

describe('findDuplicateTypeDefinitions', () => {
  it('reports the same type name declared in two files', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', { types: [typeDecl('UserProfile', 'interface', 1)] }),
        facts('file:///workspace/b.ts', { types: [typeDecl('UserProfile', 'class', 4)] }),
      ],
    };
    const findings = findDuplicateTypeDefinitions(index);
    expect(findings).toHaveLength(2);
    expect(findings[0].message).toContain('UserProfile');
    expect(findings[0].related[0].file).toBe('file:///workspace/b.ts');
  });

  it('skips short and single-letter names', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', { types: [typeDecl('T', 'type', 1), typeDecl('Box', 'class', 2)] }),
        facts('file:///workspace/b.ts', { types: [typeDecl('T', 'type', 1), typeDecl('Box', 'class', 2)] }),
      ],
    };
    expect(findDuplicateTypeDefinitions(index)).toEqual([]);
  });
});

describe('findInterfaceImplementationDrift', () => {
  it('reports an implementation missing interface methods', () => {
    const index = {
      files: [
        facts('file:///workspace/contracts.ts', {
          types: [
            typeDecl('UserRepo', 'interface', 2, { methods: ['find', 'save'] }),
          ],
        }),
        facts('file:///workspace/repo.ts', {
          types: [typeDecl('SqlRepo', 'class', 5, { implements: ['UserRepo'], methods: ['find'] })],
        }),
      ],
    };
    const findings = findInterfaceImplementationDrift(index);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-interface-implementation-drift',
      file: 'file:///workspace/repo.ts',
      line: 5,
    });
    expect(findings[0].message).toContain('save');
    expect(findings[0].related[0].file).toBe('file:///workspace/contracts.ts');
  });

  it('stays quiet for complete implementations and unknown implementers', () => {
    const index = {
      files: [
        facts('file:///workspace/contracts.ts', {
          types: [typeDecl('UserRepo', 'interface', 2, { methods: ['find'] })],
        }),
        facts('file:///workspace/repo.ts', {
          types: [typeDecl('SqlRepo', 'class', 5, { implements: ['UserRepo'], methods: ['find'] })],
        }),
        facts('file:///workspace/other.ts', {
          types: [typeDecl('MemoryRepo', 'class', 1, { methods: [] })],
        }),
      ],
    };
    expect(findInterfaceImplementationDrift(index)).toEqual([]);
  });
});

describe('findDivergentConstants', () => {
  it('reports the same upper-snake constant with different values', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          constants: [{ name: 'TIMEOUT_MS', value: '5000', line: 2 }],
        }),
        facts('file:///workspace/b.ts', {
          constants: [{ name: 'TIMEOUT_MS', value: '3000', line: 8 }],
        }),
      ],
    };
    const findings = findDivergentConstants(index);
    expect(findings).toHaveLength(2);
    expect(findings[0].message).toContain('TIMEOUT_MS');
    expect(findings[0].related[0].file).toBe('file:///workspace/b.ts');
  });

  it('ignores matching values and non upper-snake names', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          constants: [
            { name: 'MAX_RETRIES', value: '3', line: 2 },
            { name: 'timeoutMs', value: '1', line: 3 },
          ],
        }),
        facts('file:///workspace/b.ts', {
          constants: [
            { name: 'MAX_RETRIES', value: '3', line: 2 },
            { name: 'timeoutMs', value: '2', line: 3 },
          ],
        }),
      ],
    };
    expect(findDivergentConstants(index)).toEqual([]);
  });
});

describe('findMixedAsyncPatterns', () => {
  it('reports a file with at least two handlers of each style', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          functions: [
            fn('loadOne', 1, { callbackStyle: true }),
            fn('loadTwo', 2, { callbackStyle: true }),
            fn('saveOne', 3, { promiseStyle: true }),
            fn('saveTwo', 4, { promiseStyle: true }),
          ],
        }),
      ],
    };
    const findings = findMixedAsyncPatterns(index);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-mixed-async-patterns',
      file: 'file:///workspace/a.ts',
      line: 1,
    });
  });

  it('stays quiet when one style dominates', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          functions: [
            fn('loadOne', 1, { callbackStyle: true }),
            fn('saveOne', 2, { promiseStyle: true }),
            fn('saveTwo', 3, { promiseStyle: true }),
          ],
        }),
      ],
    };
    expect(findMixedAsyncPatterns(index)).toEqual([]);
  });
});

describe('findDuplicateHttpClients', () => {
  it('reports clients of the same kind with different configuration', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          httpClients: [clientOf('api', 'axios', "axios.create({ baseURL: 'https://a.example' })", 4)],
        }),
        facts('file:///workspace/b.ts', {
          httpClients: [clientOf('api', 'axios', "axios.create({ baseURL: 'https://b.example' })", 6)],
        }),
      ],
    };
    const findings = findDuplicateHttpClients(index);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ ruleId: 'xf-duplicate-http-clients', severity: 'info' });
    expect(findings[0].related[0].file).toBe('file:///workspace/b.ts');
  });

  it('stays quiet for identical configuration and different kinds', () => {
    const same = "axios.create({ baseURL: 'https://a.example' })";
    const index = {
      files: [
        facts('file:///workspace/a.ts', { httpClients: [clientOf('api', 'axios', same, 4)] }),
        facts('file:///workspace/b.ts', { httpClients: [clientOf('api', 'axios', same, 6)] }),
        facts('file:///workspace/c.ts', {
          httpClients: [clientOf('session', 'requests', 'requests.Session()', 1)],
        }),
      ],
    };
    expect(findDuplicateHttpClients(index)).toEqual([]);
  });
});

describe('findNamingDrift', () => {
  it('reports three files using different verbs for the same concept', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', { functions: [fn('getUser', 1)] }),
        facts('file:///workspace/b.ts', { functions: [fn('fetchUser', 2)] }),
        facts('file:///workspace/c.ts', { functions: [fn('loadUser', 3)] }),
      ],
    };
    const findings = findNamingDrift(index);
    expect(findings).toHaveLength(3);
    expect(findings[0]).toMatchObject({ ruleId: 'xf-naming-drift', category: 'smell' });
    expect(findings[0].message).toContain('getUser');
  });

  it('stays quiet below three files or with a single verb', () => {
    const two = {
      files: [
        facts('file:///workspace/a.ts', { functions: [fn('getUser', 1)] }),
        facts('file:///workspace/b.ts', { functions: [fn('fetchUser', 2)] }),
      ],
    };
    const sameVerb = {
      files: [
        facts('file:///workspace/a.ts', { functions: [fn('getUser', 1)] }),
        facts('file:///workspace/b.ts', { functions: [fn('getUser', 2)] }),
        facts('file:///workspace/c.ts', { functions: [fn('getUser', 3)] }),
      ],
    };
    expect(findNamingDrift(two)).toEqual([]);
    expect(findNamingDrift(sameVerb)).toEqual([]);
  });
});

describe('findMissingSiblingAuth', () => {
  it('reports the handler without auth when two siblings enforce it', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          handlers: [handlerOf('handleGetUser', { line: 1, hasAuth: true, method: 'GET' })],
        }),
        facts('file:///workspace/b.ts', {
          handlers: [handlerOf('handleGetUser', { line: 2, hasAuth: true, method: 'GET' })],
        }),
        facts('file:///workspace/c.ts', {
          handlers: [handlerOf('handleGetUser', { line: 5, hasAuth: false, method: 'GET' })],
        }),
      ],
    };
    const findings = findMissingSiblingAuth(index);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-missing-sibling-auth',
      category: 'vulnerability',
      severity: 'warning',
      file: 'file:///workspace/c.ts',
      line: 5,
    });
    expect(findings[0].related).toHaveLength(2);
  });

  it('stays quiet when only one sibling has auth or all are protected', () => {
    const oneSibling = {
      files: [
        facts('file:///workspace/a.ts', {
          handlers: [handlerOf('handleGetUser', { hasAuth: true, method: 'GET' })],
        }),
        facts('file:///workspace/c.ts', {
          handlers: [handlerOf('handleGetUser', { hasAuth: false, method: 'GET' })],
        }),
      ],
    };
    const allProtected = {
      files: [
        facts('file:///workspace/a.ts', {
          handlers: [handlerOf('handleGetUser', { hasAuth: true, method: 'GET' })],
        }),
        facts('file:///workspace/b.ts', {
          handlers: [handlerOf('handleGetUser', { hasAuth: true, method: 'GET' })],
        }),
        facts('file:///workspace/c.ts', {
          handlers: [handlerOf('handleGetUser', { hasAuth: true, method: 'GET' })],
        }),
      ],
    };
    expect(findMissingSiblingAuth(oneSibling)).toEqual([]);
    expect(findMissingSiblingAuth(allProtected)).toEqual([]);
  });
});

describe('findMissingSiblingValidation', () => {
  it('reports the handler without validation when three siblings validate', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          handlers: [handlerOf('handlePostUser', { line: 1, hasValidation: true, method: 'POST' })],
        }),
        facts('file:///workspace/b.ts', {
          handlers: [handlerOf('handlePostUser', { line: 2, hasValidation: true, method: 'POST' })],
        }),
        facts('file:///workspace/c.ts', {
          handlers: [handlerOf('handlePostUser', { line: 3, hasValidation: true, method: 'POST' })],
        }),
        facts('file:///workspace/d.ts', {
          handlers: [handlerOf('handlePostUser', { line: 9, hasValidation: false, method: 'POST' })],
        }),
      ],
    };
    const findings = findMissingSiblingValidation(index);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-missing-sibling-validation',
      category: 'vulnerability',
      severity: 'warning',
      file: 'file:///workspace/d.ts',
    });
  });

  it('stays quiet with only two validating siblings', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          handlers: [handlerOf('handlePostUser', { hasValidation: true, method: 'POST' })],
        }),
        facts('file:///workspace/b.ts', {
          handlers: [handlerOf('handlePostUser', { hasValidation: true, method: 'POST' })],
        }),
        facts('file:///workspace/c.ts', {
          handlers: [handlerOf('handlePostUser', { hasValidation: false, method: 'POST' })],
        }),
      ],
    };
    expect(findMissingSiblingValidation(index)).toEqual([]);
  });
});

describe('findSqlTwinInconsistency', () => {
  it('reports the concatenating file when a sibling is parameterized', () => {
    const index = {
      files: [
        facts('file:///workspace/src/users.ts', {
          sql: [{ line: 4, parameterized: true, concatenated: false }],
        }),
        facts('file:///workspace/src/search.ts', {
          sql: [{ line: 9, parameterized: false, concatenated: true }],
        }),
      ],
    };
    const findings = findSqlTwinInconsistency(index);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-sql-twin-inconsistency',
      category: 'vulnerability',
      severity: 'warning',
      file: 'file:///workspace/src/search.ts',
      line: 9,
    });
    expect(findings[0].related[0].file).toBe('file:///workspace/src/users.ts');
  });

  it('stays quiet across directories and when every sibling concatenates', () => {
    const otherDir = {
      files: [
        facts('file:///workspace/lib/users.ts', {
          sql: [{ line: 1, parameterized: true, concatenated: false }],
        }),
        facts('file:///workspace/src/search.ts', {
          sql: [{ line: 2, parameterized: false, concatenated: true }],
        }),
      ],
    };
    const bothConcat = {
      files: [
        facts('file:///workspace/src/users.ts', {
          sql: [{ line: 1, parameterized: false, concatenated: true }],
        }),
        facts('file:///workspace/src/search.ts', {
          sql: [{ line: 2, parameterized: false, concatenated: true }],
        }),
      ],
    };
    expect(findSqlTwinInconsistency(otherDir)).toEqual([]);
    expect(findSqlTwinInconsistency(bothConcat)).toEqual([]);
  });
});

describe('findDuplicatedSecretsAcrossFiles', () => {
  const secret = {
    value: 'sk_live_abcdefghijklmnop1234',
    line: 2,
    ruleId: 'scan-any-stripe-key',
  };

  it('reports the same secret literal in two files without echoing it', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', { secrets: [secret] }),
        facts('file:///workspace/b.ts', { secrets: [{ ...secret, line: 6 }] }),
      ],
    };
    const findings = findDuplicatedSecretsAcrossFiles(index);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-duplicated-secrets',
      category: 'vulnerability',
      severity: 'warning',
      file: 'file:///workspace/a.ts',
      line: 2,
    });
    expect(findings[0].message).not.toContain(secret.value);
    expect(findings[0].related[0].file).toBe('file:///workspace/b.ts');
  });

  it('stays quiet when the literal appears in a single file', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          secrets: [secret, { ...secret, line: 9 }],
        }),
      ],
    };
    expect(findDuplicatedSecretsAcrossFiles(index)).toEqual([]);
  });
});

describe('resolveSpecifier', () => {
  it('resolves relative imports with and without extensions', () => {
    const known = new Set([
      'file:///workspace/src/b.ts',
      'file:///workspace/src/utils/index.ts',
    ]);
    expect(resolveSpecifier('file:///workspace/src/a.ts', './b', known)).toBe(
      'file:///workspace/src/b.ts',
    );
    expect(resolveSpecifier('file:///workspace/src/a.ts', './utils', known)).toBe(
      'file:///workspace/src/utils/index.ts',
    );
    expect(resolveSpecifier('file:///workspace/src/a.ts', 'react', known)).toBeUndefined();
  });
});

describe('parseShotgunLog', () => {
  it('reports pairs that change together across directories', () => {
    const log = '__DF_COMMIT__\nsrc/a.ts\nlib/b.ts\n'.repeat(6);
    const findings = parseShotgunLog(log, 5);
    expect(findings.map((finding) => finding.file).sort()).toEqual([
      'lib/b.ts',
      'src/a.ts',
    ]);
  });

  it('ignores pairs in the same directory', () => {
    const log = '__DF_COMMIT__\nsrc/a.ts\nsrc/b.ts\n'.repeat(6);
    expect(parseShotgunLog(log, 5)).toEqual([]);
  });
});

describe('phase 7 extraction helpers', () => {
  it('extracts exported mutable module state', async () => {
    const source = [
      'export let counter = 0;',
      'export var registry = {};',
      'export const cache = new Map();',
      'export const frozen = [];',
      'function bump() {',
      '  counter += 1;',
      '  cache.set(1, 2);',
      '}',
    ].join('\n');
    const result = await extract(source);
    expect(result.mutableState.map((record) => `${record.name}:${record.kind}`)).toEqual([
      'counter:let',
      'registry:var',
      'cache:map',
    ]);
  });

  it('extracts state writes for assignments and mutator calls', async () => {
    const source = [
      'function run() {',
      '  counter = counter + 1;',
      '  registry.entries = 2;',
      '  cache.set("a", 1);',
      '  cache.delete("a");',
      '  tags.push("x");',
      '}',
    ].join('\n');
    const result = await extract(source);
    expect(result.stateWrites.map((record) => record.name).sort()).toEqual([
      'cache',
      'cache',
      'counter',
      'registry',
      'tags',
    ]);
  });

  it('classifies listener add and remove calls', async () => {
    const source = [
      "window.addEventListener('resize', onResize);",
      "window.removeEventListener('resize', onResize);",
      "emitter.on('data', handleData);",
      "emitter.off('data', handleData);",
    ].join('\n');
    const result = await extract(source);
    expect(result.listeners.map((record) => `${record.event}:${record.kind}`)).toEqual([
      'resize:add',
      'resize:remove',
      'data:add',
      'data:remove',
    ]);
  });

  it('marks caches that have an eviction path', async () => {
    const source = [
      'const bounded = new Map();',
      'const unbounded = new Map();',
      'function run() {',
      '  bounded.set(1, 2);',
      '  bounded.delete(1);',
      '  unbounded.set(1, 2);',
      '}',
    ].join('\n');
    const result = await extract(source);
    expect(result.moduleCaches.map((record) => `${record.name}:${record.evicted}`)).toEqual([
      'bounded:true',
      'unbounded:false',
    ]);
  });

  it('extracts enum and union members', async () => {
    const source = [
      'export enum Color { Red = "red", Blue = "blue" }',
      'export type Status = "open" | "closed";',
    ].join('\n');
    const result = await extract(source);
    expect(result.types.map((record) => `${record.name}:${record.members.join('|')}`)).toEqual([
      'Color:Red|Blue',
      'Status:"open"|"closed"',
    ]);
  });

  it('extracts literal http call sites with method and path shape', async () => {
    const source = [
      "fetch('/api/users');",
      "axios.post('/api/users', body);",
      "api.get('/api/users/42');",
      "requests.delete('/api/users/7');",
      'api.get(`/api/users/${id}`);',
    ].join('\n');
    const result = await extract(source);
    expect(result.httpCalls.map((record) => `${record.method || 'ANY'} ${record.pathShape}`)).toEqual([
      'ANY /api/users',
      'POST /api/users',
      'GET /api/users/:n',
      'DELETE /api/users/:n',
    ]);
  });

  it('extracts http clients created inside functions', async () => {
    const source = [
      "export const api = axios.create({ baseURL: 'https://a.example' });",
      'export function load() {',
      '  const client = new HttpClient();',
      '  return client;',
      '}',
    ].join('\n');
    const result = await extract(source);
    expect(result.scopedHttpClients.map((record) => record.kind)).toEqual(['httpclient']);
  });

  it('extracts python requests call sites and sessions', async () => {
    const source = [
      "requests.get('/api/users')",
      "session.post('/api/users')",
      'def load():',
      '    client = requests.Session()',
      '    return client',
    ].join('\n');
    const tree = await service.parse(source, 'python');
    const profile = profileFor('python');
    const result = extractFileFacts(tree!, source, profile!);
    expect(result.httpCalls.map((record) => `${record.method || 'ANY'} ${record.pathShape}`)).toEqual([
      'GET /api/users',
      'POST /api/users',
    ]);
    expect(result.scopedHttpClients.map((record) => record.kind)).toEqual(['requests']);
  });
});

describe('findDuplicateStateStores', () => {
  it('reports similar module cache names across files', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', { moduleCaches: [cacheOf('userCache', 'map', 2)] }),
        facts('file:///workspace/b.ts', { moduleCaches: [cacheOf('USER_CACHE', 'map', 5)] }),
      ],
    };
    const findings = findDuplicateStateStores(index);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-duplicate-state-stores',
      severity: 'info',
      file: 'file:///workspace/a.ts',
      line: 2,
    });
  });

  it('reports the same storage key in multiple files', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          storageKeys: [{ key: 'theme', access: 'write', line: 1 }],
        }),
        facts('file:///workspace/b.ts', {
          storageKeys: [{ key: 'theme', access: 'read', line: 2 }],
        }),
        facts('file:///workspace/c.ts', {
          storageKeys: [{ key: 'other', access: 'write', line: 3 }],
        }),
      ],
    };
    const findings = findDuplicateStateStores(index);
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.message.includes('theme'))).toBe(true);
  });
});

describe('findSharedMutableState', () => {
  const state = facts('file:///workspace/state.ts', {
    mutableState: [{ name: 'counter', kind: 'let', line: 1, exported: true }],
  });

  it('reports exported state written by two importers', () => {
    const index = {
      files: [
        state,
        facts('file:///workspace/a.ts', {
          imports: [importOf('./state', ['counter'])],
          stateWrites: [{ name: 'counter', line: 4 }],
        }),
        facts('file:///workspace/b.ts', {
          imports: [importOf('./state', ['counter'])],
          stateWrites: [{ name: 'counter', line: 9 }],
        }),
      ],
    };
    const findings = findSharedMutableState(index);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-shared-mutable-state',
      category: 'bug',
      severity: 'warning',
      file: 'file:///workspace/state.ts',
      line: 1,
    });
    expect(findings[0].related).toHaveLength(2);
  });

  it('stays quiet for a single writer or readers only', () => {
    const single = {
      files: [
        state,
        facts('file:///workspace/a.ts', {
          imports: [importOf('./state', ['counter'])],
          stateWrites: [{ name: 'counter', line: 4 }],
        }),
      ],
    };
    const readers = {
      files: [
        state,
        facts('file:///workspace/a.ts', { imports: [importOf('./state', ['counter'])] }),
        facts('file:///workspace/b.ts', { imports: [importOf('./state', ['counter'])] }),
      ],
    };
    expect(findSharedMutableState(single)).toEqual([]);
    expect(findSharedMutableState(readers)).toEqual([]);
  });
});

describe('findEnumDrift', () => {
  it('reports the same enum name with different members', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          types: [typeDecl('Status', 'enum', 1, { members: ['OPEN', 'CLOSED'] })],
        }),
        facts('file:///workspace/b.ts', {
          types: [typeDecl('Status', 'enum', 4, { members: ['OPEN', 'CLOSED', 'ARCHIVED'] })],
        }),
      ],
    };
    const findings = findEnumDrift(index);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ ruleId: 'xf-enum-drift', category: 'smell', severity: 'info' });
    expect(findings[0].message).toContain('Status');
  });

  it('stays quiet when member sets match', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          types: [typeDecl('Status', 'enum', 1, { members: ['OPEN', 'CLOSED'] })],
        }),
        facts('file:///workspace/b.ts', {
          types: [typeDecl('Status', 'type', 4, { members: ['CLOSED', 'OPEN'] })],
        }),
      ],
    };
    expect(findEnumDrift(index)).toEqual([]);
  });
});

describe('findEndpointMismatch', () => {
  const api = facts('file:///workspace/api.ts', {
    handlers: [handlerOf('handleGetUser', { line: 3, method: 'GET', pathShape: '/users/:p' })],
  });

  it('reports a call whose path matches no handler', () => {
    const index = {
      files: [
        api,
        facts('file:///workspace/client.ts', {
          httpCalls: [httpCallOf('GET', '/users/42', 5), httpCallOf('GET', '/missing', 8)],
        }),
      ],
    };
    const findings = findEndpointMismatch(index);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-endpoint-mismatch',
      category: 'bug',
      severity: 'warning',
      file: 'file:///workspace/client.ts',
      line: 8,
    });
  });

  it('reports unused routes only when the repo has ten or more call sites', () => {
    const many = Array.from({ length: 10 }, (_value, index) =>
      httpCallOf('GET', `/known/${index}`, index),
    );
    const tenPlus = {
      files: [
        api,
        facts('file:///workspace/client.ts', { httpCalls: many }),
      ],
    };
    const unused = findEndpointMismatch(tenPlus).filter(
      (finding) => finding.ruleId === 'xf-unused-endpoint',
    );
    expect(unused).toHaveLength(1);
    expect(unused[0].file).toBe('file:///workspace/api.ts');
    const few = {
      files: [
        api,
        facts('file:///workspace/client.ts', { httpCalls: [httpCallOf('GET', '/known/1', 1)] }),
      ],
    };
    expect(findEndpointMismatch(few).some((finding) => finding.ruleId === 'xf-unused-endpoint')).toBe(
      false,
    );
  });
});

describe('findUnboundedCaches', () => {
  it('reports caches without an eviction path', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          moduleCaches: [cacheOf('leaky', 'map', 2), cacheOf('bounded', 'set', 3, true)],
        }),
      ],
    };
    const findings = findUnboundedCaches(index);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-unbounded-caches',
      category: 'smell',
      severity: 'info',
      line: 2,
    });
  });
});

describe('findListenerLeaks', () => {
  it('reports listeners with no matching removal', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          listeners: [
            listenerOf('resize', 2),
            listenerOf('resize', 6, 'remove'),
            listenerOf('scroll', 9),
          ],
        }),
      ],
    };
    const findings = findListenerLeaks(index);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-listener-leaks',
      category: 'bug',
      severity: 'warning',
      line: 9,
    });
  });

  it('ignores non-literal listener events', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          listeners: [listenerOf('emitter.on', 1, 'add', false)],
        }),
      ],
    };
    expect(findListenerLeaks(index)).toEqual([]);
  });
});

describe('findOrphanedStorageKeys', () => {
  it('reports write-only and read-only storage keys', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          storageKeys: [{ key: 'written', access: 'write', line: 2 }],
        }),
        facts('file:///workspace/b.ts', {
          storageKeys: [{ key: 'read', access: 'read', line: 4 }],
        }),
      ],
    };
    const findings = findOrphanedStorageKeys(index);
    expect(findings.map((finding) => finding.message)).toEqual([
      'Storage key "written" is written but never read in the indexed workspace',
      'Storage key "read" is read but never written in the indexed workspace',
    ]);
  });

  it('stays quiet when a key is both read and written', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', {
          storageKeys: [{ key: 'theme', access: 'write', line: 1 }],
        }),
        facts('file:///workspace/b.ts', {
          storageKeys: [{ key: 'theme', access: 'read', line: 2 }],
        }),
      ],
    };
    expect(findOrphanedStorageKeys(index)).toEqual([]);
  });
});

describe('findPoolingInconsistency', () => {
  it('reports per-call clients while siblings share one', () => {
    const index = {
      files: [
        facts('file:///workspace/shared.ts', {
          httpClients: [clientOf('api', 'axios', 'axios.create({})', 1)],
        }),
        facts('file:///workspace/scoped.ts', {
          scopedHttpClients: [clientOf('client', 'axios', 'axios.create({})', 7)],
        }),
      ],
    };
    const findings = findPoolingInconsistency(index);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-pooling-inconsistency',
      severity: 'info',
      file: 'file:///workspace/scoped.ts',
      line: 7,
    });
  });

  it('stays quiet when no sibling pools the same library', () => {
    const index = {
      files: [
        facts('file:///workspace/scoped.ts', {
          scopedHttpClients: [clientOf('client', 'axios', 'axios.create({})', 7)],
        }),
      ],
    };
    expect(findPoolingInconsistency(index)).toEqual([]);
  });
});

describe('findTtlDrift', () => {
  it('reports a TTL constant with different values across three files', () => {
    const index = {
      files: [
        facts('file:///workspace/a.ts', { constants: [{ name: 'CACHE_TTL', value: '5000', line: 1 }] }),
        facts('file:///workspace/b.ts', { constants: [{ name: 'CACHE_TTL', value: '3000', line: 2 }] }),
        facts('file:///workspace/c.ts', { constants: [{ name: 'CACHE_TTL', value: '1000', line: 3 }] }),
      ],
    };
    const findings = findTtlDrift(index);
    expect(findings).toHaveLength(3);
    expect(findings[0]).toMatchObject({
      ruleId: 'xf-ttl-drift',
      category: 'smell',
      severity: 'info',
    });
    expect(findings[0].message).toContain('CACHE_TTL');
  });

  it('stays quiet with two files or matching values', () => {
    const two = {
      files: [
        facts('file:///workspace/a.ts', { constants: [{ name: 'CACHE_TTL', value: '5000', line: 1 }] }),
        facts('file:///workspace/b.ts', { constants: [{ name: 'CACHE_TTL', value: '3000', line: 2 }] }),
      ],
    };
    const matching = {
      files: [
        facts('file:///workspace/a.ts', { constants: [{ name: 'CACHE_TTL', value: '5000', line: 1 }] }),
        facts('file:///workspace/b.ts', { constants: [{ name: 'CACHE_TTL', value: '5000', line: 2 }] }),
        facts('file:///workspace/c.ts', { constants: [{ name: 'CACHE_TTL', value: '5000', line: 3 }] }),
      ],
    };
    expect(findTtlDrift(two)).toEqual([]);
    expect(findTtlDrift(matching)).toEqual([]);
  });
});

describe('DuplicationIndex facts persistence', () => {
  it('ignores an older cache version and rebuilds with facts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-cross-'));
    const storageFile = path.join(dir, 'duplication-index.json');
    await fs.writeFile(
      storageFile,
      JSON.stringify({
        version: 1,
        files: { 'file:///workspace/old.ts': { mtime: 0, size: 0, entries: [] } },
      }),
    );
    const index = new DuplicationIndex({
      parse: (text, languageId) => service.parse(text, languageId),
      storageFile,
    });
    await index.indexFile(
      'file:///workspace/fresh.ts',
      "import './other';\nexport const alpha = 1;\nexport const beta = 2;\n",
      'typescript',
    );
    const stored = await index.getFacts();
    expect(stored.map((file) => file.file)).toEqual(['file:///workspace/fresh.ts']);
    expect(stored[0].imports[0]).toMatchObject({ specifier: './other' });
    await index.setPairVerdict('pair-1', {
      verdict: 'drifted',
      reason: 'different retries',
      recommendation: 'share one helper',
    });
    index.dispose();
    let raw: {
      version?: number;
      files?: Record<string, { imports?: unknown[] }>;
      aiPairs?: Record<string, { verdict?: string }>;
    } = {};
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        raw = JSON.parse(await fs.readFile(storageFile, 'utf-8'));
        if (raw.version === 6) {
          break;
        }
      } catch {
        // not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(raw.version).toBe(6);
    expect(raw.files?.['file:///workspace/fresh.ts']?.imports).toHaveLength(1);
    expect(raw.aiPairs?.['pair-1']?.verdict).toBe('drifted');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('indexes function names, exports, and bodies for pair review', async () => {
    const index = new DuplicationIndex({
      parse: (text, languageId) => service.parse(text, languageId),
    });
    const source = [
      'export function loadUser(id) {',
      '  const response = fetchUserRecord(id);',
      '  const profile = response.profile;',
      '  const settings = profile.settings;',
      '  const active = settings.active;',
      '  const label = profile.displayName;',
      '  return { profile, settings, active, label };',
      '}',
      'function internalHelper(value) {',
      '  const trimmed = value.trim();',
      '  const lowered = trimmed.toLowerCase();',
      '  const parts = lowered.split("-");',
      '  const joined = parts.join("_");',
      '  const final = joined.concat("!");',
      '  return final;',
      '}',
    ].join('\n');
    await index.indexFile('file:///workspace/pair.ts', source, 'typescript');
    const entries = await index.getEntries();
    const exported = entries.find((entry) => entry.name === 'loadUser');
    expect(exported?.exported).toBe(true);
    expect(exported?.body).toContain('return { profile, settings, active, label };');
    const hidden = entries.find((entry) => entry.name === 'internalHelper');
    expect(hidden?.exported).toBe(false);
    index.dispose();
  });
});
