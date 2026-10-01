import { describe, expect, it } from 'vitest';
import type { FileFacts, FunctionRecord, HandlerRecord } from '../src/scan/duplication';
import {
  classifyLayer,
  conventionDomain,
  formatConventionsSection,
  matchConvention,
  mineConventions,
  parseConventionsSection,
  replaceMemorySection,
} from '../src/scan/conventions';

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

function fnOf(name: string, line = 0, overrides: Partial<FunctionRecord> = {}): FunctionRecord {
  return {
    name,
    line,
    paramCount: 1,
    params: ['input'],
    exported: true,
    async: false,
    callbackStyle: false,
    promiseStyle: false,
    ...overrides,
  };
}

function serviceFiles(count: number, prefix: string): FileFacts[] {
  return Array.from({ length: count }, (_value, index) =>
    facts(`file:///w/src/services/${prefix}${index}Service.ts`),
  );
}

describe('classifyLayer', () => {
  it('classifies directories before file suffixes', () => {
    expect(classifyLayer('file:///w/src/services/user.ts')).toBe('services');
    expect(classifyLayer('file:///w/src/handlers/user.ts')).toBe('handlers');
    expect(classifyLayer('file:///w/src/repos/user.ts')).toBe('repositories');
    expect(classifyLayer('file:///w/src/UserService.ts')).toBe('services');
    expect(classifyLayer('file:///w/src/UserRepo.ts')).toBe('repositories');
    expect(classifyLayer('file:///w/src/UserController.ts')).toBe('handlers');
    expect(classifyLayer('file:///w/src/random.ts')).toBeUndefined();
  });
});

describe('mineConventions auth placement', () => {
  it('reports handlers that enforce auth', () => {
    const index = {
      files: [
        facts('file:///w/src/handlers/a.ts', {
          handlers: [
            handlerOf('handleLogin', { line: 2, hasAuth: true }),
            handlerOf('handleSignup', { line: 20, hasAuth: true }),
          ],
        }),
        facts('file:///w/src/handlers/b.ts', {
          handlers: [
            handlerOf('handleProfile', { line: 5, hasAuth: true }),
            handlerOf('handleHealth', { line: 30, hasAuth: false }),
          ],
        }),
      ],
    };
    const conventions = mineConventions(index);
    const auth = conventions.find((convention) => convention.id === 'auth-placement');
    expect(auth).toBeDefined();
    expect(auth?.confidence).toBe(0.75);
    expect(auth?.evidence).toHaveLength(3);
    expect(auth?.statement).toContain('3 of 4 handlers');
    expect(conventionDomain(auth!)).toBe('auth');
    expect(matchConvention(conventions, 'add rate limiting to login')).toBe(auth);
  });

  it('reports when auth is handled outside the handlers', () => {
    const index = {
      files: [
        facts('file:///w/src/handlers/a.ts', {
          handlers: [
            handlerOf('handleOne', { line: 0 }),
            handlerOf('handleTwo', { line: 10 }),
          ],
        }),
        facts('file:///w/src/handlers/b.ts', {
          handlers: [
            handlerOf('handleThree', { line: 0 }),
            handlerOf('handleFour', { line: 10 }),
          ],
        }),
      ],
    };
    const auth = mineConventions(index).find((convention) => convention.id === 'auth-placement');
    expect(auth?.statement).toContain('not handled in most handlers');
    expect(auth?.confidence).toBe(1);
  });

  it('stays silent when the ratio is mixed', () => {
    const index = {
      files: [
        facts('file:///w/src/handlers/a.ts', {
          handlers: [
            handlerOf('handleOne', { line: 0, hasAuth: true }),
            handlerOf('handleTwo', { line: 10, hasAuth: false }),
          ],
        }),
        facts('file:///w/src/handlers/b.ts', {
          handlers: [
            handlerOf('handleThree', { line: 0, hasAuth: true }),
            handlerOf('handleFour', { line: 10, hasAuth: false }),
          ],
        }),
      ],
    };
    expect(mineConventions(index).some((convention) => convention.id === 'auth-placement')).toBe(false);
  });
});

describe('mineConventions validation placement', () => {
  it('reports handler-layer validation', () => {
    const index = {
      files: [
        facts('file:///w/src/handlers/a.ts', {
          handlers: [
            handlerOf('handleCreate', { line: 1, hasValidation: true }),
            handlerOf('handleUpdate', { line: 15, hasValidation: true }),
          ],
        }),
        facts('file:///w/src/handlers/b.ts', {
          handlers: [handlerOf('handleDelete', { line: 4, hasValidation: true })],
        }),
        facts('file:///w/src/services/userService.ts', {
          functions: [fnOf('createUser', 3)],
        }),
      ],
    };
    const validation = mineConventions(index).find(
      (convention) => convention.id === 'validation-placement',
    );
    expect(validation?.statement).toContain('Validation happens in the handler layer');
    expect(validation?.confidence).toBe(1);
  });

  it('reports service-layer validation', () => {
    const index = {
      files: [
        facts('file:///w/src/handlers/a.ts', {
          handlers: [handlerOf('handleCreate', { line: 1, hasValidation: true })],
        }),
        facts('file:///w/src/services/userService.ts', {
          functions: [
            fnOf('validateUser', 3),
            fnOf('validateEmail', 9),
            fnOf('sanitizeInput', 15),
          ],
        }),
      ],
    };
    const validation = mineConventions(index).find(
      (convention) => convention.id === 'validation-placement',
    );
    expect(validation?.statement).toContain('Validation lives in the service layer');
    expect(validation?.confidence).toBe(0.75);
    expect(validation?.evidence).toHaveLength(3);
  });
});

describe('mineConventions naming suffixes', () => {
  it('reports suffixes with at least five occurrences', () => {
    const index = { files: serviceFiles(5, 'user') };
    const naming = mineConventions(index).filter((convention) => convention.id.startsWith('naming-'));
    expect(naming).toHaveLength(1);
    expect(naming[0].id).toBe('naming-service');
    expect(naming[0].statement).toContain('5 occurrences');
    expect(naming[0].confidence).toBe(1);
    expect(matchConvention(naming, 'rename the billing file')).toBe(naming[0]);
  });

  it('stays silent below the threshold', () => {
    const index = { files: serviceFiles(4, 'user') };
    expect(mineConventions(index).some((convention) => convention.id.startsWith('naming-'))).toBe(false);
  });
});

describe('mineConventions repository layering', () => {
  it('reports when services own repository imports', () => {
    const repo = 'file:///w/src/repos/userRepo.ts';
    const index = {
      files: [
        facts(repo),
        facts('file:///w/src/services/aService.ts', {
          imports: [{ specifier: '../repos/userRepo', names: ['userRepo'], line: 1 }],
        }),
        facts('file:///w/src/services/bService.ts', {
          imports: [{ specifier: '../repos/userRepo', names: ['userRepo'], line: 2 }],
        }),
        facts('file:///w/src/services/cService.ts', {
          imports: [{ specifier: '../repos/userRepo', names: ['userRepo'], line: 3 }],
        }),
      ],
    };
    const layering = mineConventions(index).find((convention) =>
      convention.id.startsWith('layering-'),
    );
    expect(layering).toBeDefined();
    expect(layering?.statement).toContain('Service files import repositories directly');
    expect(layering?.statement).toContain('3 of 3');
    expect(layering?.confidence).toBe(1);
    expect(layering?.evidence).toHaveLength(3);
  });

  it('stays silent when both layers import repositories evenly', () => {
    const repo = 'file:///w/src/repos/userRepo.ts';
    const index = {
      files: [
        facts(repo),
        facts('file:///w/src/services/aService.ts', {
          imports: [{ specifier: '../repos/userRepo', names: ['userRepo'], line: 1 }],
        }),
        facts('file:///w/src/services/bService.ts', {
          imports: [{ specifier: '../repos/userRepo', names: ['userRepo'], line: 2 }],
        }),
        facts('file:///w/src/handlers/a.ts', {
          imports: [{ specifier: '../repos/userRepo', names: ['userRepo'], line: 3 }],
        }),
        facts('file:///w/src/handlers/b.ts', {
          imports: [{ specifier: '../repos/userRepo', names: ['userRepo'], line: 4 }],
        }),
      ],
    };
    expect(
      mineConventions(index).some((convention) => convention.id.startsWith('layering-')),
    ).toBe(false);
  });
});

describe('convention memory sections', () => {
  const conventions = [
    { id: 'auth-placement', statement: 'Handlers enforce auth.', confidence: 0.8, evidence: [] },
    { id: 'naming-service', statement: 'Services use the Service suffix.', confidence: 0.5, evidence: [] },
  ];

  it('round-trips through the memory section', () => {
    const memory = `# Project memory\n\n${formatConventionsSection(conventions)}`;
    const parsed = parseConventionsSection(memory);
    expect(parsed.map((convention) => convention.statement)).toEqual([
      'Handlers enforce auth.',
      'Services use the Service suffix.',
    ]);
    expect(conventionDomain(parsed[0])).toBe('auth');
  });

  it('replaces a section and detects no-op writes', () => {
    const section = formatConventionsSection(conventions);
    const memory = `# Project memory\n\n${section}`;
    expect(replaceMemorySection(memory, '## Conventions', section)).toBeUndefined();
    const next = replaceMemorySection(memory, '## Conventions', '## Conventions\n- Only one.');
    expect(next).toContain('- Only one.');
    expect(next).not.toContain('Handlers enforce auth.');
  });
});
