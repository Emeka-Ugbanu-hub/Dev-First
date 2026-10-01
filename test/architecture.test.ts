import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import type { FileFacts, FunctionRecord, HandlerRecord, TypeRecord } from '../src/scan/duplication';
import type { LLMProvider, StreamEvent } from '../src/llm/types';
import {
  breadcrumbPath,
  buildArchitectureTree,
  classifyFileDomain,
  findArchitectureNode,
  refineTree,
  resolveNodeAfterRebuild,
} from '../src/architecture/model';
import type { ArchitectureNode } from '../src/architecture/model';
import {
  activationFor,
  conceptChildren,
  fileChildren,
  shouldRenderDiagram,
} from '../webview/src/architectureView';
import type { ArchitectureChild } from '../webview/src/architectureView';
import {
  DOMAIN_INFER_SYSTEM,
  buildDomainSummary,
  inferDomains,
  parseInferredDomains,
} from '../src/architecture/infer';
import type { InferredDomain } from '../src/architecture/infer';
import { computeRelations } from '../src/architecture/relations';
import type { ArchitectureRelation } from '../src/architecture/relations';
import { classifyLevelChildren, orderLevel } from '../src/architecture/flow';
import {
  LEVEL_LABELS_SYSTEM,
  buildLevelSummary,
  cachedLevelLabels,
  filterLevelLabels,
  inferLevelLabels,
  levelSummaryHash,
  parseLevelLabels,
} from '../src/architecture/labels';
import type { LevelLabels } from '../src/architecture/labels';
import {
  findPackageRoots,
  parseCargoToml,
  parseGoMod,
  parsePackageJson,
  parsePyprojectToml,
} from '../src/architecture/manifests';
import {
  ArchitectureSession,
  createDebouncedRefresh,
  edgeVerbFor,
  levelRelations,
  mermaidForNode,
  openArchitectureFile,
  truncateSubtext,
} from '../src/architecture/panel';

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

function typeOf(name: string, overrides: Partial<TypeRecord> = {}): TypeRecord {
  return {
    name,
    kind: 'class',
    line: 0,
    exported: true,
    methods: [],
    implements: [],
    members: [],
    ...overrides,
  };
}

function fnOf(name: string, overrides: Partial<FunctionRecord> = {}): FunctionRecord {
  return {
    name,
    line: 0,
    paramCount: 1,
    params: ['input'],
    exported: true,
    async: false,
    callbackStyle: false,
    promiseStyle: false,
    ...overrides,
  };
}

function allNodes(node: ArchitectureNode): ArchitectureNode[] {
  return [node, ...node.children.flatMap(allNodes)];
}

function archNode(
  overrides: Partial<ArchitectureNode> & Pick<ArchitectureNode, 'id' | 'kind' | 'label'>,
): ArchitectureNode {
  return {
    description: '',
    usedBy: [],
    dependsOn: [],
    implementedBy: 1,
    files: [],
    children: [],
    ...overrides,
  };
}

function fileChild(
  id: string,
  label: string,
  file: string,
  description = '',
): ArchitectureNode {
  return archNode({ id, kind: 'component', label, description, files: [file] });
}

function viewChild(overrides: Partial<ArchitectureChild>): ArchitectureChild {
  return {
    id: 'node',
    kind: 'component',
    label: 'Node',
    description: '',
    usedBy: [],
    dependsOn: [],
    implementedBy: 1,
    fileCount: 1,
    ...overrides,
  };
}

interface TestMessage {
  type: string;
  text?: string;
  node?: { id: string; label: string; files: string[] };
  children?: Array<{ id: string; label?: string; subtext?: string }>;
  diagram?: string;
  coverage?: { indexedFiles: number; representedFiles: number; unsupportedSourceFiles: number };
}

function levelMessages(messages: TestMessage[]): TestMessage[] {
  return messages.filter((message) => message.type === 'level');
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-first-architecture-'));
  tempRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function factsFor(root: string, relative: string): FileFacts {
  return facts(`file://${join(root, relative)}`);
}

function providerReturning(responses: string[]): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      id: 'test',
      async *chat(): AsyncGenerator<StreamEvent> {
        const raw = responses[Math.min(calls, responses.length - 1)] ?? '';
        calls++;
        yield { type: 'text', text: raw };
        yield { type: 'done' };
      },
      listModels: async () => [],
      embed: async () => [],
    },
  };
}

function routeFiles(count: number): FileFacts[] {
  return Array.from({ length: count }, (_value, index) =>
    facts(`file:///w/src/routes/route${index}.ts`),
  );
}

describe('classifyFileDomain', () => {
  it('classifies backend signals', () => {
    expect(classifyFileDomain(facts('file:///w/src/routes/users.ts'))).toBe('backend');
    expect(classifyFileDomain(facts('file:///w/src/UserController.ts'))).toBe('unclassified');
    expect(
      classifyFileDomain(
        facts('file:///w/src/server/entry.ts', {
          handlers: [handlerOf('handleGetUser', { method: 'GET', pathShape: '/users' })],
        }),
      ),
    ).toBe('backend');
  });

  it('classifies server-language sources and leaves unmatched scripts unclassified', () => {
    expect(classifyFileDomain(facts('file:///w/src-tauri/src/main.rs'))).toBe('backend');
    expect(classifyFileDomain(facts('file:///w/Cargo.toml'))).toBe('configuration');
    expect(classifyFileDomain(facts('file:///w/cmd/server/main.go'))).toBe('backend');
    expect(classifyFileDomain(facts('file:///w/internal/store.go'))).toBe('backend');
    expect(classifyFileDomain(facts('file:///w/src/main/java/App.java'))).toBe('backend');
    expect(classifyFileDomain(facts('file:///w/src/engineRunner.ts'))).toBe('unclassified');
  });

  it('classifies frontend signals', () => {
    expect(classifyFileDomain(facts('file:///w/src/components/Button.tsx'))).toBe('frontend');
    expect(classifyFileDomain(facts('file:///w/src/hooks/useUser.ts'))).toBe('frontend');
    expect(classifyFileDomain(facts('file:///w/src/pages/Home.ts'))).toBe('frontend');
  });

  it('classifies database signals', () => {
    expect(classifyFileDomain(facts('file:///w/src/repositories/user.ts'))).toBe('database');
    expect(classifyFileDomain(facts('file:///w/src/models/user.ts'))).toBe('database');
    expect(classifyFileDomain(facts('file:///w/migrations/001_init.sql'))).toBe('database');
    expect(classifyFileDomain(facts('file:///w/src/store.ts'))).toBe('unclassified');
    expect(classifyFileDomain(facts('file:///w/src/persistenceLayer.ts'))).toBe('unclassified');
  });

  it('classifies infrastructure signals', () => {
    expect(classifyFileDomain(facts('file:///w/Dockerfile'))).toBe('infrastructure');
    expect(classifyFileDomain(facts('file:///w/k8s/deployment.yaml'))).toBe('infrastructure');
    expect(classifyFileDomain(facts('file:///w/terraform/main.tf'))).toBe('infrastructure');
  });

  it('classifies external service signals', () => {
    expect(classifyFileDomain(facts('file:///w/src/clients/stripe.ts'))).toBe(
      'external-services',
    );
    expect(classifyFileDomain(facts('file:///w/src/webhooks/stripe.ts'))).toBe(
      'external-services',
    );
    expect(
      classifyFileDomain(
        facts('file:///w/src/gateway.ts', {
          httpClients: [{ name: 'api', line: 0, kind: 'axios', config: 'axios.create()' }],
        }),
      ),
    ).toBe('external-services');
  });

  it('classifies worker signals', () => {
    expect(classifyFileDomain(facts('file:///w/src/jobs/cleanup.ts'))).toBe('workers');
    expect(classifyFileDomain(facts('file:///w/src/queues/email.ts'))).toBe('workers');
    expect(classifyFileDomain(facts('file:///w/src/reportScheduler.ts'))).toBe('unclassified');
  });

  it('classifies shared signals and leaves unmatched files unclassified', () => {
    expect(classifyFileDomain(facts('file:///w/src/utils/format.ts'))).toBe('shared');
    expect(classifyFileDomain(facts('file:///w/src/types/user.ts'))).toBe('shared');
    expect(classifyFileDomain(facts('file:///w/src/random.ts'))).toBe('unclassified');
  });
});

describe('buildArchitectureTree domains', () => {
  it('preserves small domain groups instead of moving files by group size', () => {
    const files = [
      ...routeFiles(5),
      facts('file:///w/src/components/A.tsx'),
      facts('file:///w/src/components/B.tsx'),
      facts('file:///w/Dockerfile'),
    ];
    const tree = buildArchitectureTree(files);
    const labels = tree.children.map((child) => child.label);
    expect(labels).toContain('Backend');
    expect(labels).toContain('Infrastructure');
    expect(labels).toContain('Frontend');
    expect(labels).not.toContain('Shared');
    expect(tree.children.find((child) => child.label === 'Frontend')?.files.length).toBe(2);
  });

  it('keeps Shared files in their evidence-based group regardless of count', () => {
    const five = buildArchitectureTree(
      Array.from({ length: 5 }, (_value, index) =>
        facts(`file:///w/src/utils/u${index}.ts`),
      ),
    );
    expect(five.children.map((child) => child.label)).toEqual(['Shared']);
    const four = buildArchitectureTree(
      Array.from({ length: 4 }, (_value, index) =>
        facts(`file:///w/src/utils/u${index}.ts`),
      ),
    );
    expect(four.children.map((child) => child.label)).toEqual(['Shared']);
  });

  it('classifies language-dominant Rust source as Backend', () => {
    const rust = Array.from({ length: 6 }, (_value, index) =>
      facts(`file:///w/src/module${index}.rs`),
    );
    const labels = buildArchitectureTree(rust).children.map((child) => child.label);
    expect(labels).toContain('Backend');
    expect(labels).not.toContain('Unclassified');
  });

  it('classifies server-language sources and unclassified files separately', () => {
    const mixed = [
      facts('file:///w/src/a.ts'),
      facts('file:///w/src/b.py'),
      facts('file:///w/src/c.go'),
    ];
    expect(buildArchitectureTree(mixed).children.map((child) => child.label).sort()).toEqual([
      'Backend',
      'Unclassified',
    ]);
  });

  it('labels unmatched files Unclassified with a verification hint', () => {
    const tree = buildArchitectureTree([
      facts('file:///w/src/engineRunner.ts'),
      facts('file:///w/src/random.ts'),
    ]);
    const domain = tree.children.find((child) => child.label === 'Unclassified');
    expect(domain?.description).toBe(
      'Files that did not match any domain signal — verify their placement or add a signal.',
    );
    expect(domain?.files).toHaveLength(2);
  });

  it('never merges Unclassified into Shared', () => {
    const files = [
      ...Array.from({ length: 5 }, (_value, index) =>
        facts(`file:///w/src/utils/u${index}.ts`),
      ),
      facts('file:///w/src/engineRunner.ts'),
    ];
    const tree = buildArchitectureTree(files);
    const labels = tree.children.map((child) => child.label);
    expect(labels).toContain('Shared');
    expect(labels).toContain('Unclassified');
    const unclassified = tree.children.find((child) => child.label === 'Unclassified');
    expect(unclassified?.files).toEqual(['file:///w/src/engineRunner.ts']);
  });
});

describe('manifest package boundaries', () => {
  it('parses package.json names and workspaces', () => {
    expect(parsePackageJson('{"name":"alpha","workspaces":["packages/*"]}')).toEqual({
      name: 'alpha',
      workspaces: ['packages/*'],
    });
    expect(parsePackageJson('{"name":"beta","workspaces":{"packages":["apps/*"]}}')).toEqual({
      name: 'beta',
      workspaces: ['apps/*'],
    });
    expect(parsePackageJson('not json')).toBeUndefined();
  });

  it('parses Cargo.toml packages and workspaces', () => {
    expect(parseCargoToml('[package]\nname = "engine"\nversion = "0.1.0"\n')).toEqual({
      name: 'engine',
      workspaces: [],
    });
    expect(
      parseCargoToml('[workspace]\nmembers = [\n  "crates/core",\n  "crates/api",\n]\n'),
    ).toEqual({ workspaces: ['crates/core', 'crates/api'] });
  });

  it('parses go.mod modules and pyproject names', () => {
    expect(parseGoMod('module github.com/acme/service\n\ngo 1.22\n')).toBe('service');
    expect(parsePyprojectToml('[project]\nname = "analytics"\n')).toBe('analytics');
    expect(parsePyprojectToml('[tool.poetry]\nname = "legacy"\n')).toBe('legacy');
  });

  it('finds package roots up to three levels deep', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'workspace-root' }),
      'packages/a/package.json': JSON.stringify({ name: 'alpha' }),
      'packages/b/package.json': JSON.stringify({ name: 'beta' }),
      'packages/b/nested/package.json': JSON.stringify({ name: 'gamma' }),
      'packages/c/one/two/package.json': JSON.stringify({ name: 'too-deep' }),
    });
    const roots = findPackageRoots(root);
    expect(roots).toEqual([
      { root: '.', name: 'workspace-root' },
      { root: 'packages/a', name: 'alpha' },
      { root: 'packages/b', name: 'beta' },
      { root: 'packages/b/nested', name: 'gamma' },
    ]);
  });

  it('groups a monorepo into one domain per package root', () => {
    const root = workspace({
      'packages/a/package.json': JSON.stringify({ name: 'alpha' }),
      'packages/a/src/routes/index.ts': '',
      'packages/b/package.json': JSON.stringify({ name: 'beta' }),
      'packages/b/src/components/Button.tsx': '',
      'packages/b/src/components/Card.tsx': '',
    });
    const files = [
      factsFor(root, 'packages/a/src/routes/index.ts'),
      factsFor(root, 'packages/b/src/components/Button.tsx'),
      factsFor(root, 'packages/b/src/components/Card.tsx'),
    ];
    const tree = buildArchitectureTree(files);
    expect(tree.children.map((child) => child.label).sort()).toEqual(['alpha', 'beta']);
    expect(tree.children.find((child) => child.label === 'beta')?.files).toHaveLength(2);
  });

  it('falls back to directory names when manifests omit names', () => {
    const root = workspace({
      'packages/a/package.json': '{}',
      'packages/a/index.ts': '',
      'packages/b/go.mod': 'module example.com/beacon\n',
      'packages/b/main.go': '',
    });
    const files = [
      factsFor(root, 'packages/a/index.ts'),
      factsFor(root, 'packages/b/main.go'),
    ];
    const tree = buildArchitectureTree(files);
    expect(tree.children.map((child) => child.label).sort()).toEqual(['a', 'beacon']);
  });

  it('keeps single-package projects on the existing signals', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'solo' }),
      'a.ts': '',
      'b.ts': '',
    });
    const tree = buildArchitectureTree([
      factsFor(root, 'a.ts'),
      factsFor(root, 'b.ts'),
    ]);
    expect(tree.children.map((child) => child.label)).toEqual(['Unclassified']);
  });

  it('lets files outside every package fall through to signals', () => {
    const root = workspace({
      'packages/a/package.json': JSON.stringify({ name: 'alpha' }),
      'packages/a/index.ts': '',
      'packages/b/package.json': JSON.stringify({ name: 'beta' }),
      'packages/b/index.ts': '',
      'Dockerfile': '',
    });
    const tree = buildArchitectureTree([
      factsFor(root, 'packages/a/index.ts'),
      factsFor(root, 'packages/b/index.ts'),
      factsFor(root, 'Dockerfile'),
    ]);
    expect(tree.children.map((child) => child.label).sort()).toEqual([
      'Infrastructure',
      'alpha',
      'beta',
    ]);
  });
});

describe('buildArchitectureTree components', () => {
  it('adds an implementations level only when a component has more than one file', () => {
    const shared = buildArchitectureTree([
      facts('file:///w/src/a/userService.ts', { types: [typeOf('UserService')] }),
      facts('file:///w/src/b/userService.ts', { types: [typeOf('UserService')] }),
    ]);
    const component = allNodes(shared).find((node) => node.kind === 'component');
    expect(component?.label).toBe('UserService');
    expect(component?.children.map((child) => child.kind)).toEqual(['file', 'file']);
    expect(component?.children.map((child) => child.files[0]).sort()).toEqual([
      'file:///w/src/a/userService.ts',
      'file:///w/src/b/userService.ts',
    ]);

    const single = buildArchitectureTree([
      facts('file:///w/src/components/Button.tsx', { functions: [fnOf('Button')] }),
    ]);
    expect(allNodes(single).some((node) => node.kind === 'component')).toBe(false);
    const button = allNodes(single).find((node) => node.kind === 'file');
    expect(button?.label).toBe('Button');
    expect(button?.files).toEqual(['file:///w/src/components/Button.tsx']);
  });

  it('ends every branch in file leaves and keeps every file once', () => {
    const files = [
      ...routeFiles(3),
      facts('file:///w/src/db/user.ts'),
      facts('file:///w/src/db/order.ts'),
      facts('file:///w/src/db/session.ts'),
      facts('file:///w/src/components/Button.tsx'),
      facts('file:///w/src/utils/format.ts'),
      facts('file:///w/Dockerfile'),
    ];
    const tree = buildArchitectureTree(files);
    for (const node of allNodes(tree)) {
      if (node.children.length === 0) {
        expect(node.kind).toBe('file');
      }
    }
    const leaves = allNodes(tree)
      .filter((node) => node.kind === 'file')
      .map((node) => node.files[0]);
    expect(new Set(leaves)).toEqual(new Set(files.map((file) => file.file)));
  });

  it('preserves all children beyond the former 40-node display cap', () => {
    const files = Array.from({ length: 45 }, (_value, index) =>
      facts(
        `file:///w/src/components/dir${String(index + 1).padStart(2, '0')}/A.tsx`,
      ),
    );
    const tree = buildArchitectureTree(files);
    const domain = tree.children.find((child) => child.label === 'Frontend');
    expect(domain?.children.length).toBe(45);
    expect(domain?.children[0].files[0]).toContain('/dir01/A.tsx');
    expect(domain?.children[44].files[0]).toContain('/dir45/A.tsx');
  });
});

describe('refineTree', () => {
  const fileOf = (id: string, label: string, uri: string): ArchitectureNode =>
    archNode({ id, kind: 'file', label, description: uri, files: [uri] });

  it('collapses duplicate-label levels', () => {
    const files = [
      fileOf('file:a', 'a.ts', 'file:///w/a.ts'),
      fileOf('file:b', 'b.ts', 'file:///w/b.ts'),
    ];
    const component = archNode({
      id: 'component',
      kind: 'component',
      label: 'components',
      files: ['file:///w/a.ts', 'file:///w/b.ts'],
      children: files,
    });
    const domain = archNode({
      id: 'domain',
      kind: 'domain',
      label: 'Components',
      children: [component],
    });
    refineTree(domain);
    expect(domain.children.map((child) => child.id)).toEqual(['file:a', 'file:b']);
  });

  it('merges single-child chains and keeps the top label', () => {
    const files = [
      fileOf('file:a', 'a.ts', 'file:///w/a.ts'),
      fileOf('file:b', 'b.ts', 'file:///w/b.ts'),
    ];
    const inner = archNode({
      id: 'inner',
      kind: 'subsystem',
      label: 'Inner',
      children: files,
    });
    const outer = archNode({
      id: 'outer',
      kind: 'subsystem',
      label: 'Outer',
      children: [inner],
    });
    const domain = archNode({
      id: 'domain',
      kind: 'domain',
      label: 'Backend',
      children: [outer],
    });
    refineTree(domain);
    expect(domain.label).toBe('Backend');
    expect(domain.children.map((child) => child.id)).toEqual(['file:a', 'file:b']);
  });

  it('flattens a single-file component into a file node', () => {
    const file = fileOf('file:button', 'Button.tsx', 'file:///w/src/components/Button.tsx');
    const component = archNode({
      id: 'component',
      kind: 'component',
      label: 'components',
      files: ['file:///w/src/components/Button.tsx'],
      children: [file],
    });
    const domain = archNode({
      id: 'domain',
      kind: 'domain',
      label: 'Frontend',
      children: [component],
    });
    refineTree(domain);
    expect(domain.children).toHaveLength(1);
    expect(domain.children[0].kind).toBe('file');
    expect(domain.children[0].label).toBe('Button');
    expect(domain.children[0].files).toEqual(['file:///w/src/components/Button.tsx']);
  });

  it('keeps multi-file components and removes single implementations', () => {
    const component = archNode({
      id: 'component',
      kind: 'component',
      label: 'UserService',
      files: ['file:///w/a.ts', 'file:///w/b.ts'],
      children: [
        archNode({
          id: 'impl:a',
          kind: 'implementation',
          label: 'a',
          files: ['file:///w/a.ts'],
          children: [fileOf('file:a', 'a.ts', 'file:///w/a.ts')],
        }),
        archNode({
          id: 'impl:b',
          kind: 'implementation',
          label: 'b',
          files: ['file:///w/b.ts'],
          children: [fileOf('file:b', 'b.ts', 'file:///w/b.ts')],
        }),
      ],
    });
    const subsystem = archNode({
      id: 'subsystem',
      kind: 'subsystem',
      label: 'Services',
      children: [component],
    });
    refineTree(subsystem);
    expect(subsystem.children).toHaveLength(1);
    expect(subsystem.children[0].kind).toBe('component');
    expect(subsystem.children[0].children.map((child) => child.kind)).toEqual([
      'file',
      'file',
    ]);
    expect(subsystem.children[0].children.map((child) => child.files[0]).sort()).toEqual([
      'file:///w/a.ts',
      'file:///w/b.ts',
    ]);

    const multi = archNode({
      id: 'component:multi',
      kind: 'component',
      label: 'Multi',
      files: ['file:///w/a.ts', 'file:///w/b.ts'],
      children: [
        archNode({
          id: 'impl:multi',
          kind: 'implementation',
          label: 'multi',
          files: ['file:///w/a.ts', 'file:///w/b.ts'],
          children: [
            fileOf('file:a', 'a.ts', 'file:///w/a.ts'),
            fileOf('file:b', 'b.ts', 'file:///w/b.ts'),
          ],
        }),
        fileOf('file:c', 'c.ts', 'file:///w/c.ts'),
      ],
    });
    const wrapper = archNode({
      id: 'wrapper',
      kind: 'subsystem',
      label: 'Wrapper',
      children: [multi],
    });
    refineTree(wrapper);
    expect(wrapper.children[0].kind).toBe('component');
    expect(wrapper.children[0].children.map((child) => child.kind)).toEqual([
      'implementation',
      'file',
    ]);

    const single = archNode({
      id: 'component:single',
      kind: 'component',
      label: 'Service',
      files: ['file:///w/a.ts'],
      children: [
        archNode({
          id: 'impl:single',
          kind: 'implementation',
          label: 'a',
          files: ['file:///w/a.ts'],
          children: [fileOf('file:a', 'a.ts', 'file:///w/a.ts')],
        }),
      ],
    });
    const domain = archNode({
      id: 'domain',
      kind: 'domain',
      label: 'Backend',
      children: [single],
    });
    refineTree(domain);
    expect(domain.children).toHaveLength(1);
    expect(domain.children[0].kind).toBe('file');
    expect(domain.children[0].label).toBe('a');
  });

  it('collapses duplicate labels in a built tree', () => {
    const tree = buildArchitectureTree([
      facts('file:///w/src/components/A.ts'),
      facts('file:///w/src/components/B.ts'),
      facts('file:///w/src/hooks/C.ts'),
    ]);
    expect(allNodes(tree).some((node) => node.kind === 'component')).toBe(false);
    const frontend = tree.children.find((child) => child.label === 'Frontend');
    const components = frontend?.children.find((child) => child.label === 'Components');
    expect(components?.children.map((child) => child.kind)).toEqual(['file', 'file']);
    expect(components?.children.map((child) => child.files[0]).sort()).toEqual([
      'file:///w/src/components/A.ts',
      'file:///w/src/components/B.ts',
    ]);
  });
});

describe('architecture view', () => {
  it('renders a diagram only when concept children exist', () => {
    expect(shouldRenderDiagram([])).toBe(false);
    expect(
      shouldRenderDiagram([viewChild({ kind: 'file', file: 'file:///w/a.ts' })]),
    ).toBe(false);
    expect(shouldRenderDiagram([viewChild({ id: 'concept' })])).toBe(true);
    expect(
      shouldRenderDiagram([
        viewChild({ id: 'concept' }),
        viewChild({ kind: 'file', file: 'file:///w/a.ts' }),
      ]),
    ).toBe(true);
  });

  it('keeps concepts in the diagram and files in the list for mixed levels', () => {
    const children = [
      viewChild({ id: 'concept', label: 'Services', kind: 'component' }),
      viewChild({ id: 'file:a', kind: 'file', label: 'a.ts', file: 'file:///w/a.ts' }),
    ];
    expect(conceptChildren(children).map((child) => child.id)).toEqual(['concept']);
    expect(fileChildren(children).map((child) => child.file)).toEqual(['file:///w/a.ts']);
    expect(shouldRenderDiagram(children)).toBe(true);
  });

  it('opens file nodes and drills into concept nodes', () => {
    expect(
      activationFor(viewChild({ kind: 'file', file: 'file:///w/a.ts' })),
    ).toEqual({ type: 'openFile', path: 'file:///w/a.ts' });
    expect(activationFor(viewChild({ id: 'concept' }))).toEqual({
      type: 'drillDown',
      id: 'concept',
    });
  });
});

describe('buildArchitectureTree relationships', () => {
  it('aggregates import edges into usedBy and dependsOn', () => {
    const files = [
      facts('file:///w/src/routes/users.ts', {
        imports: [{ specifier: '../db/user', names: ['user'], line: 0 }],
      }),
      facts('file:///w/src/routes/health.ts'),
      facts('file:///w/src/routes/orders.ts'),
      facts('file:///w/src/db/user.ts'),
      facts('file:///w/src/db/order.ts'),
      facts('file:///w/src/db/session.ts'),
    ];
    const tree = buildArchitectureTree(files);
    const backend = tree.children.find((child) => child.label === 'Backend');
    const database = tree.children.find((child) => child.label === 'Database');
    expect(backend?.dependsOn).toContain('Database');
    expect(database?.usedBy).toContain('Backend');
    const importer = allNodes(tree).find(
      (node) => node.kind === 'file' && node.files[0] === 'file:///w/src/routes/users.ts',
    );
    expect(importer?.dependsOn).toContain('user.ts');
    const target = allNodes(tree).find(
      (node) => node.kind === 'file' && node.files[0] === 'file:///w/src/db/user.ts',
    );
    expect(target?.usedBy).toContain('users.ts');
  });
});

describe('breadcrumbPath', () => {
  it('builds the path from the project root to a node', () => {
    const tree = buildArchitectureTree(routeFiles(3));
    const file = allNodes(tree).find(
      (node) =>
        node.kind === 'file' && node.files[0] === 'file:///w/src/routes/route0.ts',
    );
    expect(file).toBeDefined();
    const path = breadcrumbPath(tree, file!.id);
    expect(path.map((node) => node.kind)).toEqual([
      'project',
      'domain',
      'component',
      'file',
    ]);
    expect(path[0]).toBe(tree);
    expect(findArchitectureNode(tree, file!.id)).toBe(file);
    expect(breadcrumbPath(tree, 'missing')).toEqual([]);
  });
});

describe('resolveNodeAfterRebuild', () => {
  const tree = buildArchitectureTree(routeFiles(3));

  it('returns the node when its id still exists', () => {
    const file = allNodes(tree).find(
      (node) =>
        node.kind === 'file' && node.files[0] === 'file:///w/src/routes/route0.ts',
    );
    expect(file).toBeDefined();
    expect(resolveNodeAfterRebuild(file!.id, tree)).toBe(file);
  });

  it('walks parent ids when the node vanished', () => {
    const component = allNodes(tree).find((node) => node.kind === 'component');
    expect(component).toBeDefined();
    const missing = `${component!.id}/subsystem:gone/component:gone`;
    expect(resolveNodeAfterRebuild(missing, tree)).toBe(component);
  });

  it('falls back to the root when nothing survives', () => {
    expect(resolveNodeAfterRebuild('domain:ghost/subsystem:ghost', tree)).toBe(tree);
    expect(resolveNodeAfterRebuild('missing', tree)).toBe(tree);
  });
});

describe('createDebouncedRefresh', () => {
  it('coalesces invalidation events into one rebuild after the delay', () => {
    vi.useFakeTimers();
    try {
      let rebuilds = 0;
      const debounced = createDebouncedRefresh(() => {
        rebuilds++;
      }, 2000);
      debounced.schedule();
      vi.advanceTimersByTime(1000);
      debounced.schedule();
      vi.advanceTimersByTime(1000);
      expect(rebuilds).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(rebuilds).toBe(1);
      debounced.schedule();
      debounced.dispose();
      vi.advanceTimersByTime(5000);
      expect(rebuilds).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ArchitectureSession', () => {
  function sessionFor(
    getFacts: () => Promise<FileFacts[]>,
    overrides: Partial<{
      isVisible: () => boolean;
    }> = {},
  ): { session: ArchitectureSession; messages: TestMessage[] } {
    const messages: TestMessage[] = [];
    const session = new ArchitectureSession({
      getFacts,
      post: (message) => messages.push(message as TestMessage),
      isVisible: overrides.isVisible ?? (() => true),
    });
    return { session, messages };
  }

  it('refresh clears the cached tree and rebuilds from the latest facts', async () => {
    let current = routeFiles(3);
    const { session, messages } = sessionFor(async () => current);
    await session.load();
    const initial = levelMessages(messages).at(-1);
    expect(initial?.node?.files).toHaveLength(3);
    expect(initial?.coverage).toMatchObject({ indexedFiles: 3, representedFiles: 3, unsupportedSourceFiles: 0 });
    current = [
      facts('file:///w/src/db/user.ts'),
      facts('file:///w/src/db/order.ts'),
      facts('file:///w/src/db/session.ts'),
    ];
    await session.refresh();
    const latest = levelMessages(messages).at(-1);
    expect(new Set(latest?.node?.files)).toEqual(
      new Set(current.map((file) => file.file)),
    );
    expect(latest?.node?.files).not.toContain('file:///w/src/routes/route0.ts');
    expect(messages.find((message) => message.type === 'refreshed')?.text).toBe(
      'Updated just now',
    );
    session.dispose();
  });

  it('emits a hint when the current position disappears', async () => {
    let current = routeFiles(3);
    const { session, messages } = sessionFor(async () => current);
    await session.load();
    const component = allNodes(buildArchitectureTree(current)).find(
      (node) => node.kind === 'component',
    );
    expect(component).toBeDefined();
    session.navigate(component!.id);
    expect(session.currentNodeId).toBe(component!.id);
    messages.length = 0;
    current = [
      facts('file:///w/src/controllers/alpha.ts'),
      facts('file:///w/src/controllers/beta.ts'),
      facts('file:///w/src/controllers/gamma.ts'),
    ];
    await session.refresh();
    const hint = messages.find((message) => message.type === 'hint');
    expect(hint?.text).toContain('no longer exists');
    const latest = levelMessages(messages).at(-1);
    expect(latest?.node?.id).not.toBe(component!.id);
    expect(component!.id.startsWith(`${latest?.node?.id}/`)).toBe(true);
    session.dispose();
  });

  it('does not render while the panel is hidden', async () => {
    let current = routeFiles(3);
    let visible = true;
    const messages: TestMessage[] = [];
    const session = new ArchitectureSession({
      getFacts: async () => current,
      post: (message) => messages.push(message as TestMessage),
      isVisible: () => visible,
    });
    await session.load();
    messages.length = 0;
    visible = false;
    current = routeFiles(1);
    await session.refresh({ auto: true });
    expect(levelMessages(messages)).toHaveLength(0);
    visible = true;
    session.renderIfPending();
    expect(levelMessages(messages)).toHaveLength(1);
    session.dispose();
  });

  it('keeps manual refresh working after a failed rebuild', async () => {
    let fail = false;
    let current = routeFiles(3);
    const { session, messages } = sessionFor(async () => {
      if (fail) {
        throw new Error('index unavailable');
      }
      return current;
    });
    await session.load();
    fail = true;
    await session.refresh();
    expect(messages.at(-1)?.text).toBe('Refresh failed');
    fail = false;
    current = routeFiles(1);
    await session.refresh();
    expect(messages.filter((message) => message.type === 'refreshed').at(-1)?.text).toBe(
      'Updated just now',
    );
    session.dispose();
  });

  it('does not call AI to change factual architecture placement', async () => {
    const files = [
      ...routeFiles(3),
      facts('file:///w/src/utils/format.ts'),
      facts('file:///w/src/utils/parse.ts'),
      facts('file:///w/src/utils/colors.ts'),
    ];
    const { session, messages } = sessionFor(async () => files);
    await session.load();
    const before = levelMessages(messages).at(-1)?.children?.map((child) => child.label);
    await session.refresh();
    expect(levelMessages(messages).at(-1)?.children?.map((child) => child.label)).toEqual(before);
    session.dispose();
  });
});

describe('ArchitectureSession lazy level labels', () => {
  const groupFiles = [
    facts('file:///w/src/routes/a/one.ts'),
    facts('file:///w/src/routes/a/two.ts'),
    facts('file:///w/src/routes/b/one.ts'),
    facts('file:///w/src/routes/b/two.ts'),
    facts('file:///w/src/db/user.ts'),
  ];
  const rootLabels = JSON.stringify({
    nodes: [{ id: 'domain:backend', label: 'API', subtext: 'Handles every HTTP route' }],
  });
  const backendLabels = JSON.stringify({
    nodes: [
      {
        id: 'domain:backend/subsystem:routes/component:dir-routes-a',
        label: 'Read routes',
        subtext: 'Serves read endpoints',
      },
    ],
  });

  function labelSession(
    getFacts: () => Promise<FileFacts[]>,
    provider: LLMProvider | undefined,
    cache: Map<string, LevelLabels | null>,
  ): { session: ArchitectureSession; messages: TestMessage[] } {
    const messages: TestMessage[] = [];
    const session = new ArchitectureSession({
      getFacts,
      post: (message) => messages.push(message as TestMessage),
      isVisible: () => true,
      ...(provider ? { getProvider: async () => ({ provider, model: 'model' }) } : {}),
      labelsCache: cache,
    });
    return { session, messages };
  }

  it('builds without an AI call, labels once on first open, and reuses the cache', async () => {
    const { provider, calls } = providerReturning([rootLabels]);
    const cache = new Map<string, LevelLabels | null>();
    const { session, messages } = labelSession(async () => groupFiles, provider, cache);
    await session.load();
    expect(calls()).toBe(0);
    expect(levelMessages(messages).at(-1)?.diagram).toContain('…');
    session.renderCurrent();
    await flush();
    expect(calls()).toBe(1);
    const labeled = levelMessages(messages).at(-1);
    expect(labeled?.children?.map((child) => child.label)).toContain('API');
    expect(labeled?.diagram).toContain('Handles every HTTP route');
    session.navigate('project');
    await flush();
    expect(calls()).toBe(1);
    expect(cache.size).toBe(1);
    session.dispose();
  });

  it('labels each group level once and reuses cached labels on reopen', async () => {
    const { provider, calls } = providerReturning([rootLabels, backendLabels]);
    const cache = new Map<string, LevelLabels | null>();
    const { session, messages } = labelSession(async () => groupFiles, provider, cache);
    await session.load();
    session.renderCurrent();
    await flush();
    expect(calls()).toBe(1);
    session.navigate('domain:backend');
    await flush();
    expect(calls()).toBe(2);
    expect(levelMessages(messages).at(-1)?.children?.map((child) => child.label)).toContain(
      'Read routes',
    );
    session.navigate('project');
    await flush();
    session.navigate('domain:backend');
    await flush();
    expect(calls()).toBe(2);
    expect(cache.size).toBe(2);
    session.dispose();
  });

  it('keeps deterministic output without a provider', async () => {
    const cache = new Map<string, LevelLabels | null>();
    const { session, messages } = labelSession(async () => groupFiles, undefined, cache);
    await session.load();
    session.renderCurrent();
    await flush();
    expect(cache.size).toBe(0);
    const latest = levelMessages(messages).at(-1);
    expect(latest?.children?.map((child) => child.label)).toContain('Backend');
    expect(latest?.diagram).not.toContain('…');
    session.dispose();
  });

  it('regenerates labels when the level summary changes after a refresh', async () => {
    let current = groupFiles;
    const { provider, calls } = providerReturning([rootLabels, rootLabels]);
    const cache = new Map<string, LevelLabels | null>();
    const { session } = labelSession(async () => current, provider, cache);
    await session.load();
    session.renderCurrent();
    await flush();
    expect(calls()).toBe(1);
    current = [...groupFiles, facts('file:///w/src/utils/format.ts')];
    await session.refresh();
    await flush();
    expect(calls()).toBe(2);
    session.dispose();
  });
});

describe('openArchitectureFile', () => {
  it('reports a deleted file with a status message and nothing else', async () => {
    const status: Array<{ text: string; timeout: number }> = [];
    let opened = false;
    await openArchitectureFile('file:///w/src/routes/gone.ts', {
      exists: async () => false,
      open: async () => {
        opened = true;
      },
      status: (text, timeout) => status.push({ text, timeout }),
    });
    expect(opened).toBe(false);
    expect(status).toEqual([{ text: 'Dev-First: file no longer exists', timeout: 3000 }]);
  });

  it('opens a file that still exists', async () => {
    const status: string[] = [];
    let opened = '';
    await openArchitectureFile('file:///w/src/routes/route0.ts', {
      exists: async () => true,
      open: async (path) => {
        opened = path;
      },
      status: (text) => status.push(text),
    });
    expect(opened).toBe('file:///w/src/routes/route0.ts');
    expect(status).toEqual([]);
  });
});

describe('inferDomains', () => {
  const files = [
    ...routeFiles(3),
    facts('file:///w/src/utils/format.ts'),
    facts('file:///w/src/utils/parse.ts'),
    facts('file:///w/src/utils/colors.ts'),
  ];
  const deterministic = buildArchitectureTree(files);
  const validResponse = JSON.stringify({
    domains: [
      { label: 'API', description: 'HTTP layer.', folders: ['routes'], subsystems: ['Routes'] },
      { label: 'Toolkit', description: 'Helpers.', folders: ['utils'], subsystems: ['Utils'] },
    ],
  });

  it('replaces domains with one cached AI call', async () => {
    const { provider, calls } = providerReturning([validResponse]);
    const cache = new Map<string, InferredDomain[]>();
    const tree = await inferDomains(files, deterministic, {
      provider,
      model: 'model',
      cache,
    });
    expect(tree.children.map((child) => child.label).sort()).toEqual(['API', 'Toolkit']);
    expect(calls()).toBe(1);
    const second = await inferDomains(files, deterministic, {
      provider,
      model: 'model',
      cache,
    });
    expect(second.children.map((child) => child.label).sort()).toEqual(['API', 'Toolkit']);
    expect(calls()).toBe(1);
  });

  it('falls back to the deterministic tree when files are not assigned', async () => {
    const { provider } = providerReturning([
      JSON.stringify({
        domains: [
          { label: 'API', description: '', folders: ['nowhere'], subsystems: [] },
        ],
      }),
    ]);
    const tree = await inferDomains(files, deterministic, { provider, model: 'model' });
    expect(tree).toBe(deterministic);
  });

  it('falls back on invalid JSON', async () => {
    const { provider } = providerReturning(['not json at all']);
    const tree = await inferDomains(files, deterministic, { provider, model: 'model' });
    expect(tree).toBe(deterministic);
  });

  it('returns the deterministic tree without a provider', async () => {
    const tree = await inferDomains(files, deterministic, {
      provider: undefined,
      model: 'model',
    });
    expect(tree).toBe(deterministic);
  });

  it('rejects malformed domains', () => {
    expect(parseInferredDomains('{"domains":[]}')).toBeUndefined();
    expect(parseInferredDomains('{"domains":[{"label":""}]}')).toBeUndefined();
    expect(parseInferredDomains('{"domains":[{"label":"API","folders":[]}]}')).toBeUndefined();
    expect(
      parseInferredDomains('{"domains":[{"label":"Application","folders":["src"]}]}'),
    ).toBeUndefined();
    expect(parseInferredDomains('{"domains":[{"label":"API","folders":["src"]}]}')).toEqual([
      { label: 'API', description: '', folders: ['src'], subsystems: [] },
    ]);
  });
});

describe('buildDomainSummary', () => {
  it('reports extensions, roles, samples, and deterministic domains', () => {
    const files = [
      facts('file:///w/src/components/Button.tsx'),
      facts('file:///w/src/components/Card.tsx'),
      facts('file:///w/src/components/Modal.tsx'),
      facts('file:///w/src/services/userService.ts'),
      facts('file:///w/src/db/connection.ts', {
        imports: [{ specifier: 'pg', names: ['Pool'], line: 0 }],
      }),
      facts('file:///w/src/db/user.ts', {
        imports: [{ specifier: 'pg', names: ['Pool'], line: 0 }],
      }),
      facts('file:///w/src/db/order.ts', {
        imports: [{ specifier: 'prisma', names: ['PrismaClient'], line: 0 }],
      }),
      facts('file:///w/src/ipc/bridge.ts', {
        imports: [{ specifier: '@tauri-apps/api/core', names: ['invoke'], line: 0 }],
      }),
    ];
    const tree = buildArchitectureTree(files);
    const summary = buildDomainSummary(files, tree);
    expect(summary).toContain('components (3 files) [ext .tsx x3] [roles components]');
    expect(summary).toContain('[domain Frontend]');
    expect(summary).toContain('[domain Database]');
    expect(summary).toContain('roles db-imports');
    expect(summary).toContain('roles services');
    expect(summary).toContain('roles ipc');
    expect(summary).toContain('samples: components/Button.tsx');
    expect(summary).toContain('Deterministic domains:');
  });

  it('instructs the model to name domains by role and only rename Unclassified with evidence', () => {
    expect(DOMAIN_INFER_SYSTEM).toContain(
      'Frontend, Backend, Database, Workers, Infrastructure, Integrations',
    );
    expect(DOMAIN_INFER_SYSTEM).toContain('Keep the Unclassified label only');
    expect(DOMAIN_INFER_SYSTEM).toContain(
      'You may rename Unclassified only when you assign its folders to a named domain with evidence',
    );
  });
});

describe('computeRelations', () => {
  it('keeps imported and proven endpoint relationships separate with evidence', () => {
    const files = [
      facts('file:///w/src/api/users.ts', {
        imports: [{ specifier: '../handlers/user', names: ['getUser'], line: 0 }],
        httpCalls: [{ method: 'GET', path: '/users', pathShape: '/users', line: 1 }],
      }),
      facts('file:///w/src/handlers/user.ts', {
        handlers: [handlerOf('getUser', { method: 'GET', pathShape: '/users' })],
      }),
    ];
    const nodeMap = new Map([
      ['file:///w/src/api/users.ts', 'n1'],
      ['file:///w/src/handlers/user.ts', 'n2'],
    ]);
    const relations = computeRelations(files, nodeMap);
    expect(relations.map((relation) => relation.label).sort()).toEqual(['imports', 'matches endpoint']);
    expect(relations.every((relation) => relation.toId === 'n2')).toBe(true);
    expect(relations.find((relation) => relation.label === 'imports')?.evidence[0]).toMatchObject({
      fromFile: 'file:///w/src/api/users.ts', toFile: 'file:///w/src/handlers/user.ts', line: 0,
    });
    expect(relations.find((relation) => relation.label === 'matches endpoint')?.evidence)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'use site', line: 1 }),
        expect.objectContaining({ role: 'handler' }),
      ]));
  });

  it('does not let protocol imports relabel unrelated local imports', () => {
    const files = [
      facts('file:///w/src/gqlClient.ts', {
        imports: [
          { specifier: '@apollo/client', names: ['gql'], line: 0 },
          { specifier: './api', names: ['api'], line: 1 },
        ],
      }),
      facts('file:///w/src/tauriClient.ts', {
        imports: [
          { specifier: '@tauri-apps/api/core', names: ['invoke'], line: 0 },
          { specifier: './api', names: ['api'], line: 1 },
        ],
      }),
      facts('file:///w/src/api.ts'),
    ];
    const nodeMap = new Map([
      ['file:///w/src/gqlClient.ts', 'n1'],
      ['file:///w/src/tauriClient.ts', 'n2'],
      ['file:///w/src/api.ts', 'n3'],
    ]);
    const relations = computeRelations(files, nodeMap);
    expect(relations).toHaveLength(2);
    expect(relations.every((relation) => relation.label === 'imports')).toBe(true);
    expect(relations.every((relation) => relation.evidence[0].kind === 'import')).toBe(true);
  });

  it('keeps ordinary imports separate from independently evidenced endpoints', () => {
    const files = [
      facts('file:///w/src/client.ts', {
        imports: [
          { specifier: 'graphql', names: ['gql'], line: 0 },
          { specifier: './server', names: ['server'], line: 1 },
        ],
        httpCalls: [{ method: 'GET', path: '/health', pathShape: '/health', line: 2 }],
      }),
      facts('file:///w/src/server.ts', {
        handlers: [handlerOf('health', { method: 'GET', pathShape: '/health' })],
      }),
    ];
    const nodeMap = new Map([
      ['file:///w/src/client.ts', 'n1'],
      ['file:///w/src/server.ts', 'n2'],
    ]);
    const relations = computeRelations(files, nodeMap);
    expect(relations).toHaveLength(2);
    expect(relations.map((relation) => relation.label).sort()).toEqual(['imports', 'matches endpoint']);
    expect(relations.find((relation) => relation.label === 'imports')?.evidence).toHaveLength(1);
    expect(relations.find((relation) => relation.label === 'matches endpoint')?.evidence).toHaveLength(2);
  });

  it('reports unresolved local imports and unregistered Tauri invocations', async () => {
    const { analyzeArchitectureRelations } = await import('../src/architecture/relations');
    const files = [facts('file:///w/src/caller.ts', {
      imports: [{ specifier: './missing', names: ['missing'], line: 2 }],
      httpCalls: [{ method: 'IPC', path: 'missing_command', pathShape: '', line: 4 }],
    })];
    const result = analyzeArchitectureRelations(files, new Map([[files[0].file, 'n1']]));
    expect(result.relations).toEqual([]);
    expect(result.unresolvedImports).toBe(1);
    expect(result.unresolvedTauriCommands).toBe(1);
  });

  it('drops self-edges', () => {
    const files = [
      facts('file:///w/src/a.ts', {
        imports: [{ specifier: './b', names: ['b'], line: 0 }],
      }),
      facts('file:///w/src/b.ts'),
    ];
    const nodeMap = new Map([
      ['file:///w/src/a.ts', 'n1'],
      ['file:///w/src/b.ts', 'n1'],
    ]);
    expect(computeRelations(files, nodeMap)).toEqual([]);
  });
});

describe('mermaidForNode relationships', () => {
  it('renders every relationship with its evidence-backed label', () => {
    const relations: ArchitectureRelation[] = [
      { fromId: 'n1', toId: 'n2', label: 'imports', weight: 5, evidence: [] },
      { fromId: 'n2', toId: 'n1', label: 'invokes command', weight: 3, evidence: [] },
      { fromId: 'missing', toId: 'n2', label: 'matches endpoint', weight: 9, evidence: [] },
    ];
    const node = archNode({
      id: 'project',
      kind: 'project',
      label: 'Project',
      children: [
        archNode({ id: 'a', kind: 'domain', label: 'Backend', files: ['file:///w/a.ts'] }),
        archNode({ id: 'b', kind: 'domain', label: 'Database', files: ['file:///w/b.ts'] }),
      ],
    });
    const diagram = mermaidForNode(node, relations);
    expect(diagram).toContain('n1 -. "imports" .-> n2');
    expect(diagram).toContain('n2 -. "invokes command" .-> n1');
    expect(diagram).not.toContain('missing');
    const many: ArchitectureRelation[] = Array.from({ length: 13 }, (_value, index) => ({
      fromId: 'n1',
      toId: 'n2',
      label: `relation-${index}`,
      weight: 13 - index,
      evidence: [],
    }));
    const capped = mermaidForNode(node, many);
    expect(capped.match(/-\. "/g)?.length).toBe(13);
  });

  it('emits real level relations as dashed edges', () => {
    const files = [
      facts('file:///w/src/routes/users.ts', {
        imports: [
          { specifier: 'graphql', names: ['gql'], line: 0 },
          { specifier: '../db/user', names: ['user'], line: 1 },
        ],
      }),
      facts('file:///w/src/routes/health.ts'),
      facts('file:///w/src/routes/orders.ts'),
      facts('file:///w/src/db/user.ts'),
      facts('file:///w/src/db/order.ts'),
      facts('file:///w/src/db/session.ts'),
    ];
    const tree = buildArchitectureTree(files);
    const relations = levelRelations(tree, files);
    const diagram = mermaidForNode(tree, relations);
    expect(diagram).toMatch(/n1 -\. "imports" \.-> n2/);
  });
});

describe('orderLevel', () => {
  const mainFile = 'file:///w/src/main.ts';
  const serviceFile = 'file:///w/src/service.ts';
  const storeFile = 'file:///w/src/db/store.ts';
  const notifyFile = 'file:///w/src/notify.ts';
  const orphanFile = 'file:///w/src/orphan.ts';
  const files = [
    facts(mainFile, { imports: [{ specifier: './service', names: ['service'], line: 0 }] }),
    facts(serviceFile, { imports: [{ specifier: './db/store', names: ['store'], line: 0 }] }),
    facts(storeFile, { imports: [{ specifier: 'pg', names: ['Pool'], line: 0 }] }),
    facts(notifyFile, { exports: [{ name: 'notifyUser', line: 0, isDefault: false }] }),
  ];
  const children = [
    fileChild('notify', 'notify.ts', notifyFile),
    fileChild('storage', 'store.ts', storeFile),
    fileChild('orphan', 'orphan.ts', orphanFile),
    fileChild('service', 'service.ts', serviceFile),
    fileChild('main', 'main.ts', mainFile),
  ];
  const fileToNode = new Map([
    [mainFile, 'main'],
    [serviceFile, 'service'],
    [storeFile, 'storage'],
    [notifyFile, 'notify'],
  ]);

  it('classifies entry and storage from the dependency graph and explicit database imports', () => {
    const roles = classifyLevelChildren(children, files, fileToNode);
    expect(roles.get('main')).toBe('entry');
    expect(roles.get('service')).toBe('core');
    expect(roles.get('orphan')).toBe('entry');
    expect(roles.get('storage')).toBe('storage');
    expect(roles.get('notify')).toBe('entry');
  });

  it('orders graph roots first, then dependency depth, with verified storage last', () => {
    const ordered = orderLevel(children, files, fileToNode);
    expect(ordered.map((child) => child.id)).toEqual([
      'notify',
      'orphan',
      'main',
      'service',
      'storage',
    ]);
  });

  it('sorts core children by BFS depth over level imports', () => {
    const entryFile = 'file:///w/src/index.ts';
    const alphaFile = 'file:///w/src/alpha.ts';
    const betaFile = 'file:///w/src/beta.ts';
    const graphFacts = [
      facts(entryFile, { imports: [{ specifier: './alpha', names: ['alpha'], line: 0 }] }),
      facts(alphaFile, { imports: [{ specifier: './beta', names: ['beta'], line: 0 }] }),
      facts(betaFile, { imports: [{ specifier: './alpha', names: ['alpha'], line: 0 }] }),
    ];
    const graphChildren = [
      fileChild('beta', 'beta.ts', betaFile),
      fileChild('alpha', 'alpha.ts', alphaFile),
      fileChild('index', 'index.ts', entryFile),
    ];
    const map = new Map([
      [entryFile, 'index'],
      [alphaFile, 'alpha'],
      [betaFile, 'beta'],
    ]);
    const ordered = orderLevel(graphChildren, graphFacts, map);
    expect(ordered.map((child) => child.id)).toEqual(['index', 'alpha', 'beta']);
  });

  it('treats only explicit DB driver imports as verified storage', () => {
    const driverFile = 'file:///w/src/connection.ts';
    const pathFile = 'file:///w/src/store.ts';
    const driverFacts = facts(driverFile, {
      imports: [{ specifier: '@prisma/client', names: ['PrismaClient'], line: 0 }],
    });
    const roles = classifyLevelChildren(
      [fileChild('driver', 'connection.ts', driverFile), fileChild('path', 'store.ts', pathFile)],
      [driverFacts],
      new Map([
        [driverFile, 'driver'],
        [pathFile, 'path'],
      ]),
    );
    expect(roles.get('driver')).toBe('storage');
    expect(roles.get('path')).toBe('entry');
  });
});

describe('mermaidForNode flow rendering', () => {
  const mainFile = 'file:///w/src/main.ts';
  const serviceFile = 'file:///w/src/service.ts';
  const storeFile = 'file:///w/src/db/user.ts';
  const description =
    'Handles the main request pipeline for every inbound user action across the system';
  const files = [
    facts(mainFile, { imports: [{ specifier: './service', names: ['service'], line: 0 }] }),
    facts(serviceFile, { imports: [{ specifier: './db/user', names: ['user'], line: 0 }] }),
    facts(storeFile, { imports: [{ specifier: 'rusqlite', names: ['Connection'], line: 0 }] }),
  ];
  const node = archNode({
    id: 'project',
    kind: 'project',
    label: 'Project',
    files: files.map((file) => file.file),
    children: [
      fileChild('storage', 'user.ts', storeFile),
      fileChild('service', 'service.ts', serviceFile, description),
      fileChild('main', 'main.ts', mainFile),
    ],
  });

  it('draws entry as a stadium, storage as a cylinder, and others as rectangles', () => {
    const diagram = mermaidForNode(node, [], files);
    expect(diagram).toContain('n1(["main.ts (1)"])');
    expect(diagram).toContain('n3[("user.ts (1)")]');
    expect(diagram).toMatch(/n2\["service\.ts \(1\)<br\/>/);
  });

  it('truncates node subtext to the subtext cap', () => {
    expect(truncateSubtext(description)).toHaveLength(60);
    expect(truncateSubtext(description).endsWith('…')).toBe(true);
    expect(mermaidForNode(node, [], files)).toContain(truncateSubtext(description));
  });

  it('draws the parent arrow only to entry children', () => {
    const diagram = mermaidForNode(node, [], files);
    expect(diagram.match(/n0 -->/g)).toHaveLength(1);
    expect(diagram).toContain('n0 --> n1');
  });

  it('falls back to every child when no entry is identified', () => {
    const aFile = 'file:///w/src/db/a.ts';
    const bFile = 'file:///w/src/db/b.ts';
    const storageNode = archNode({
      id: 'project',
      kind: 'project',
      label: 'Project',
      files: [aFile, bFile],
      children: [fileChild('a', 'a.ts', aFile), fileChild('b', 'b.ts', bFile)],
    });
    const diagram = mermaidForNode(storageNode, [], [facts(aFile), facts(bFile)]);
    expect(diagram.match(/n0 -->/g)).toHaveLength(2);
  });

  it('uses only the evidence-backed relationship label', () => {
    expect(edgeVerbFor('GraphQL, REST', 'core', 'storage')).toBe('GraphQL, REST');
    expect(edgeVerbFor('imports', 'core', 'storage')).toBe('imports');
    expect(edgeVerbFor('invokes command', 'entry', 'core')).toBe('invokes command');
    expect(edgeVerbFor('imports', 'core', 'core')).toBe('imports');
  });

  it('renders imports without guessing click or storage operations', () => {
    const relations = levelRelations(node, files);
    const diagram = mermaidForNode(node, relations, files);
    expect(diagram).toContain('n1 -. "imports" .-> n2');
    expect(diagram).toContain('n2 -. "imports" .-> n3');
  });
});

describe('level labels', () => {
  const mainFile = 'file:///w/src/main.ts';
  const serviceFile = 'file:///w/src/service.ts';
  const storeFile = 'file:///w/src/db/user.ts';
  const files = [
    facts(mainFile, { imports: [{ specifier: './service', names: ['service'], line: 0 }] }),
    facts(serviceFile, { imports: [{ specifier: './db/user', names: ['user'], line: 0 }] }),
    facts(storeFile, { imports: [{ specifier: 'rusqlite', names: ['Connection'], line: 0 }] }),
  ];
  const node = archNode({
    id: 'project',
    kind: 'project',
    label: 'Project',
    files: files.map((file) => file.file),
    children: [
      fileChild('storage', 'user.ts', storeFile),
      fileChild('service', 'service.ts', serviceFile),
      fileChild('main', 'main.ts', mainFile),
    ],
  });
  const labels: LevelLabels = {
    nodes: [
      { id: 'main', label: 'Start', subtext: 'Boots the extension' },
      { id: 'ghost', label: 'Ghost' },
    ],
    edges: [{ from: 'main', to: 'service', verb: 'invokes' }],
  };

  it('instructs the model to answer with strict JSON', () => {
    expect(LEVEL_LABELS_SYSTEM).toContain('strict JSON only');
    expect(LEVEL_LABELS_SYSTEM).toContain('"nodes"');
  });

  it('summarizes child id, count, samples, label, and role', () => {
    const summary = buildLevelSummary(node, files);
    expect(summary).toContain('- main | 1 files | label: main.ts | role: entry');
    expect(summary).toContain('role: storage');
    expect(summary).toContain('samples: main.ts');
  });

  it('parses, caps, and validates model output', () => {
    const parsed = parseLevelLabels(
      JSON.stringify({
        nodes: [{ id: 'main', label: 'x'.repeat(120), subtext: 'y'.repeat(120) }],
        edges: [{ from: 'main', to: 'service', verb: 'z'.repeat(60) }],
      }),
    );
    expect(parsed?.nodes[0].label).toHaveLength(60);
    expect(parsed?.nodes[0].subtext).toHaveLength(80);
    expect(parsed?.edges[0].verb).toHaveLength(24);
    expect(parseLevelLabels('not json')).toBeUndefined();
    expect(parseLevelLabels('{"nodes":[],"edges":[]}')).toBeUndefined();
  });

  it('filters labels whose ids are unknown', () => {
    const filtered = filterLevelLabels(node, labels);
    expect(filtered.nodes.map((entry) => entry.id)).toEqual(['main']);
    expect(filtered.edges).toHaveLength(1);
  });

  it('does not allow AI labels to alter factual graph rendering', () => {
    const diagram = mermaidForNode(node, levelRelations(node, files), files);
    expect(diagram).toContain('main.ts');
    expect(diagram).not.toContain('Boots the extension');
    expect(diagram).not.toContain('Ghost');
    expect(diagram).toContain('-. "imports" .->');
  });

  it('reuses one cached AI call per level summary', async () => {
    const response = JSON.stringify({
      nodes: [{ id: 'main', label: 'Entry point', subtext: 'Starts the app' }],
      edges: [{ from: 'main', to: 'service', verb: 'calls' }],
    });
    const { provider, calls } = providerReturning([response]);
    const cache = new Map<string, LevelLabels | null>();
    const first = await inferLevelLabels(node, files, { provider, model: 'model', cache });
    expect(first?.nodes[0].label).toBe('Entry point');
    expect(calls()).toBe(1);
    const second = await inferLevelLabels(node, files, { provider, model: 'model', cache });
    expect(second?.edges[0].verb).toBe('calls');
    expect(calls()).toBe(1);
  });

  it('reads cached labels by summary hash', () => {
    const cache = new Map<string, LevelLabels | null>([
      [levelSummaryHash(buildLevelSummary(node, files)), labels],
    ]);
    expect(cachedLevelLabels(node, files, cache)?.nodes[0].id).toBe('main');
  });

  it('falls back deterministically without a provider or on invalid JSON', async () => {
    expect(
      await inferLevelLabels(node, files, { provider: undefined, model: 'model' }),
    ).toBeUndefined();
    const { provider } = providerReturning(['not json']);
    const cache = new Map<string, LevelLabels | null>();
    expect(
      await inferLevelLabels(node, files, { provider, model: 'model', cache }),
    ).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});
