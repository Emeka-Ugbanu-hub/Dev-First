import { describe, expect, it } from 'vitest';
import { buildLevelView } from '../src/architecture/mapLevels';
import type { StructuredMap } from '../src/architecture/mapValidate';

const map: StructuredMap = {
  nodes: [
    { id: 'root', label: 'companion' },
    { id: 'inbox', label: 'Inbox', group: 'Frontend', path: 'src/components/Inbox.tsx' },
    { id: 'settings', label: 'Settings', group: 'Frontend', path: 'src/components/Settings.tsx' },
    { id: 'commands', label: 'Commands', group: 'Backend', path: 'src/commands.ts' },
    { id: 'services', label: 'Sync Service', group: 'Backend/Services', path: 'src/services/sync.ts' },
    { id: 'db', label: 'SQLite', group: 'Database', path: 'src/database.ts' },
  ],
  edges: [
    { from: 'root', to: 'inbox', label: 'starts' },
    { from: 'inbox', to: 'commands', label: 'calls' },
    { from: 'settings', to: 'commands', label: 'calls' },
    { from: 'commands', to: 'services', label: 'uses' },
    { from: 'services', to: 'db', label: 'writes' },
  ],
};

describe('buildLevelView', () => {
  it('shows groups as single nodes with aggregated edges at the project level', () => {
    const view = buildLevelView(map, [], { inbox: 'src/components/Inbox.tsx' });
    expect(view.mermaid).toContain('root["companion"]');
    expect(view.mermaid).toContain('grp0(["Frontend (2 files)"])');
    expect(view.mermaid).toContain('grp1(["Backend (2 files)"])');
    expect(view.mermaid).toContain('grp2(["Database (1 files)"])');
    expect(view.mermaid).toContain('grp0 -->|calls| grp1');
    expect(view.mermaid).toContain('grp1 -->|writes| grp2');
    expect(Object.values(view.groups)).toEqual([['Frontend'], ['Backend'], ['Database']]);
    expect(view.breadcrumbs).toEqual([{ label: 'Project', path: [] }]);
  });

  it('drills into a group and exposes its child groups', () => {
    const view = buildLevelView(map, ['Backend'], {});
    expect(view.mermaid).toContain('commands["Commands"]');
    expect(view.mermaid).toContain('grp0(["Services (1 files)"])');
    expect(view.mermaid).toContain('commands -->|uses| grp0');
    expect(view.kind).toBe('layer');
    expect(view.items).toEqual([
      expect.objectContaining({ kind: 'group', label: 'Services', fileCount: 1 }),
    ]);
    expect(view.groups.grp0).toEqual(['Backend', 'Services']);
    expect(view.breadcrumbs.map((crumb) => crumb.label)).toEqual(['Project', 'Backend']);
  });

  it('reports external relationships without drawing outside nodes', () => {
    const project = buildLevelView(map, [], {});
    expect(project.mermaid).toContain('grp0 -->|calls| grp1');
    expect(project.related).toEqual([]);
    const backend = buildLevelView(map, ['Backend'], {});
    expect(backend.mermaid).not.toContain('Frontend');
    expect(backend.mermaid).not.toContain('classDef outside');
    expect(backend.related).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Frontend', path: ['Frontend'], count: 2 }),
      expect.objectContaining({ label: 'Database', path: ['Database'], count: 1 }),
    ]));
  });

  it('shows files and related groups when children only connect outside', () => {
    const routeMap: StructuredMap = {
      nodes: [
        { id: 'route_1', label: 'POST /subscribe', group: 'Backend/Routes', path: 'app/api/subscribe/route.ts' },
        { id: 'session', label: 'SessionController', group: 'Backend/Session', path: 'src/session/SessionController.ts' },
        { id: 'agent', label: 'AgentService', group: 'Services/Agent', path: 'src/agent/AgentService.ts' },
        { id: 'input', label: 'InputBox', group: 'Frontend/Chat', path: 'webview/src/InputBox.tsx' },
      ],
      edges: [
        { from: 'route_1', to: 'session', label: 'handles subscribe' },
        { from: 'input', to: 'session', label: 'message' },
        { from: 'session', to: 'agent', label: 'imports' },
      ],
    };
    const routes = buildLevelView(routeMap, ['Backend', 'Routes'], {
      route_1: 'app/api/subscribe/route.ts',
    });
    expect(routes.kind).toBe('files');
    expect(routes.items).toEqual([
      expect.objectContaining({ kind: 'file', label: 'POST /subscribe', route: true }),
    ]);
    expect(routes.related).toEqual([
      expect.objectContaining({ label: 'Session', path: ['Backend', 'Session'], count: 1 }),
    ]);
    expect(routes.paths).toEqual({ route_1: 'app/api/subscribe/route.ts' });
    expect(routes.mermaid).not.toContain('outside');

    const session = buildLevelView(routeMap, ['Backend', 'Session'], {
      session: 'src/session/SessionController.ts',
    });
    expect(session.items).toEqual([
      expect.objectContaining({
        kind: 'file',
        label: 'SessionController',
        uses: [expect.objectContaining({ label: 'Agent', groupPath: ['Services', 'Agent'] })],
        usedBy: expect.arrayContaining([
          expect.objectContaining({ label: 'Chat', groupPath: ['Frontend', 'Chat'] }),
          expect.objectContaining({ label: 'Routes', groupPath: ['Backend', 'Routes'] }),
        ]),
      }),
    ]);
    expect(session.related.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      ['Frontend', 'Chat'],
      ['Services', 'Agent'],
      ['Backend', 'Routes'],
    ]));
  });

  it('moves system-only groups to system targets and hides their cards', () => {
    const systemMap: StructuredMap = {
      nodes: [
        { id: 'listener', label: 'listeners', group: 'Services/Agent', path: 'src/agent/listeners.ts' },
        { id: 'agent', label: 'Agent', group: 'Services/Agent', path: 'src/agent/Agent.ts' },
        { id: 'system_events', label: 'Events / Queues', group: 'Services/Events' },
      ],
      edges: [
        { from: 'listener', to: 'system_events', label: 'listens' },
        { from: 'agent', to: 'listener', label: 'imports' },
      ],
    };
    const layer = buildLevelView(systemMap, ['Services'], {});
    expect(layer.items).toEqual([
      expect.objectContaining({ kind: 'group', label: 'Agent', fileCount: 2 }),
    ]);
    expect(layer.items.some((item) => item.label === 'Events / Queues')).toBe(false);
    expect(layer.systemTargets).toEqual([
      expect.objectContaining({
        label: 'Events / Queues',
        path: ['Services', 'Events'],
        count: 1,
        files: [expect.objectContaining({ label: 'listeners', path: 'src/agent/listeners.ts' })],
      }),
    ]);

    const files = buildLevelView(systemMap, ['Services', 'Agent'], {});
    const listener = files.items.find(
      (item): item is Extract<typeof item, { kind: 'file' }> => item.kind === 'file' && item.label === 'listeners',
    );
    expect(listener?.uses).toEqual([
      expect.objectContaining({ label: 'Events / Queues', system: true }),
    ]);
    expect(files.systemTargets).toHaveLength(1);
  });

  it('shows every child group even when it has no internal edge', () => {
    const view = buildLevelView(
      {
        nodes: [
          { id: 'api', label: 'Server', group: 'Backend/Api' },
          { id: 'lonely', label: 'Lonely', group: 'Backend/Lonely' },
        ],
        edges: [],
      },
      ['Backend'],
      {},
    );
    expect(view.mermaid).toContain('grp0(["Api (0 files)"])');
    expect(view.mermaid).toContain('grp1(["Lonely (0 files)"])');
    expect(view.kind).toBe('layer');
  });

  it('keeps only paths for the visible level nodes', () => {
    const view = buildLevelView(map, ['Frontend'], {
      inbox: 'src/components/Inbox.tsx',
      db: 'src-tauri/src/db.rs',
    });
    expect(view.paths).toEqual({ inbox: 'src/components/Inbox.tsx' });
  });

  it('omits isolated files from the relationship graph', () => {
    const view = buildLevelView(
      {
        nodes: [
          { id: 'entry', label: 'Entry' },
          { id: 'service', label: 'Service' },
          { id: 'notes', label: 'Notes' },
        ],
        edges: [{ from: 'entry', to: 'service', label: 'calls' }],
      },
      [],
      { notes: 'docs/notes.md' },
    );
    expect(view.mermaid).toContain('entry["Entry"]');
    expect(view.mermaid).toContain('service["Service"]');
    expect(view.mermaid).not.toContain('notes["Notes"]');
  });

  it('sanitizes parentheses in aggregated edge labels', () => {
    const parenMap: StructuredMap = {
      nodes: [
        { id: 'ui', label: 'Inbox', group: 'Frontend' },
        { id: 'api', label: 'Commands', group: 'Backend' },
      ],
      edges: [
        { from: 'ui', to: 'api', label: 'invoke(command)' },
        { from: 'ui', to: 'api', label: 'invoke(command)' },
      ],
    };
    const view = buildLevelView(parenMap, [], {});
    expect(view.mermaid).toContain('invoke command');
    expect(view.mermaid).not.toContain('×2');
    expect(view.mermaid).not.toContain('(command)');
  });

  it('prioritizes message and handle edges over imports when capping', () => {
    const nodes = Array.from({ length: 16 }, (_value, index) => ({
      id: `n${index}`,
      label: `Node ${index}`,
    }));
    const imports = Array.from({ length: 13 }, (_value, index) => ({
      from: `n${index}`,
      to: `n${index + 1}`,
      label: 'imports',
    }));
    const view = buildLevelView({
      nodes,
      edges: [...imports, { from: 'n0', to: 'n15', label: 'message' }],
    }, [], {});
    expect(view.mermaid).toContain('n0 -->|message| n15');
  });

  it('caps the number of edges per level', () => {
    const nodes = Array.from({ length: 15 }, (_value, index) => ({
      id: `n${index}`,
      label: `Node ${index}`,
    }));
    const edges = Array.from({ length: 14 }, (_value, index) => ({
      from: `n${index}`,
      to: `n${index + 1}`,
    }));
    const view = buildLevelView({ nodes, edges }, [], {});
    expect((view.mermaid.match(/ -->/g) ?? []).length).toBeLessThanOrEqual(12);
    expect(view.hiddenEdges).toBe(2);
    expect(view.totalEdges).toBe(14);
  });

  it('truncates long edge labels', () => {
    const nodes = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    const view = buildLevelView(
      { nodes, edges: [{ from: 'a', to: 'b', label: 'reads and writes the entire state store' }] },
      [],
      {},
    );
    expect(view.mermaid).toContain('…');
    expect(view.mermaid).not.toContain('entire state store');
  });
});
