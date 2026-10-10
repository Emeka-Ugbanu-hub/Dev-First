import { describe, expect, it } from 'vitest';
import { buildLevelView } from '../src/architecture/mapLevels';
import type { StructuredMap } from '../src/architecture/mapValidate';

const map: StructuredMap = {
  nodes: [
    { id: 'root', label: 'companion' },
    { id: 'inbox', label: 'Inbox', group: 'Frontend' },
    { id: 'settings', label: 'Settings', group: 'Frontend' },
    { id: 'commands', label: 'Commands', group: 'Backend' },
    { id: 'services', label: 'Sync Service', group: 'Backend/Services' },
    { id: 'db', label: 'SQLite', group: 'Database' },
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
    expect(view.mermaid).toContain('grp0(["Frontend"])');
    expect(view.mermaid).toContain('grp1(["Backend"])');
    expect(view.mermaid).toContain('grp2(["Database"])');
    expect(view.mermaid).toContain('grp0 -->|calls| grp1');
    expect(view.mermaid).toContain('grp1 -->|writes| grp2');
    expect(Object.values(view.groups)).toEqual([['Frontend'], ['Backend'], ['Database']]);
    expect(view.breadcrumbs).toEqual([{ label: 'Project', path: [] }]);
  });

  it('drills into a group and exposes its child groups', () => {
    const view = buildLevelView(map, ['Backend'], {});
    expect(view.mermaid).toContain('commands["Commands"]');
    expect(view.mermaid).toContain('grp0(["Services"])');
    expect(view.mermaid).toContain('commands -->|uses| grp0');
    expect(view.groups.grp0).toEqual(['Backend', 'Services']);
    expect(view.breadcrumbs.map((crumb) => crumb.label)).toEqual(['Project', 'Backend']);
  });

  it('hides nodes and edges outside the current subtree', () => {
    const project = buildLevelView(map, [], {});
    expect(project.mermaid).toContain('grp0 -->|calls| grp1');
    const backend = buildLevelView(map, ['Backend'], {});
    expect(backend.mermaid).not.toMatch(/out\d+/);
    expect(backend.mermaid).not.toContain('Frontend');
    expect(backend.mermaid).not.toContain('calls');
  });

  it('keeps only paths for the visible level nodes', () => {
    const view = buildLevelView(map, ['Frontend'], {
      inbox: 'src/components/Inbox.tsx',
      db: 'src-tauri/src/db.rs',
    });
    expect(view.paths).toEqual({ inbox: 'src/components/Inbox.tsx' });
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
