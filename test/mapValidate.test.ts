import { describe, expect, it } from 'vitest';
import { buildMermaidMap, mapPathsOf, parseStructuredMap } from '../src/architecture/mapValidate';

describe('parseStructuredMap', () => {
  it('parses JSON from fences and surrounding prose', () => {
    const raw = [
      'Here is the architecture:',
      '```json',
      '{"nodes":[{"id":"ui","label":"Components","group":"Frontend","path":"./src/components"}],',
      ' "edges":[{"from":"ui","to":"missing","label":"calls"}]}',
      '```',
    ].join('\n');
    const map = parseStructuredMap(raw);
    expect(map?.nodes).toEqual([
      { id: 'ui', label: 'Components', group: 'Frontend', path: 'src/components' },
    ]);
    expect(map?.edges).toEqual([]);
  });

  it('sanitizes ids, remaps edges, drops self-edges and duplicates', () => {
    const map = parseStructuredMap(
      JSON.stringify({
        nodes: [
          { id: 'auth service', label: 'Auth' },
          { id: 'db', label: 'Database' },
        ],
        edges: [
          { from: 'auth service', to: 'db', label: 'writes' },
          { from: 'auth service', to: 'db', label: 'writes' },
          { from: 'db', to: 'db' },
          { from: 'nope', to: 'db' },
        ],
      }),
    );
    expect(map?.nodes.map((node) => node.id)).toEqual(['auth_service', 'db']);
    expect(map?.edges).toEqual([{ from: 'auth_service', to: 'db', label: 'writes' }]);
  });

  it('caps nodes and rejects unusable payloads', () => {
    const nodes = Array.from({ length: 70 }, (_value, index) => ({
      id: `n${index}`,
      label: `Node ${index}`,
    }));
    expect(parseStructuredMap(JSON.stringify({ nodes }))?.nodes).toHaveLength(60);
    expect(parseStructuredMap('not json')).toBeUndefined();
    expect(parseStructuredMap(JSON.stringify({ edges: [] }))).toBeUndefined();
    expect(parseStructuredMap(JSON.stringify({ nodes: [{ id: '', label: '' }] }))).toBeUndefined();
  });
});

describe('buildMermaidMap', () => {
  it('builds groups as subgraphs with quoted labels and edge verbs', () => {
    const map = parseStructuredMap(
      JSON.stringify({
        nodes: [
          { id: 'root', label: 'companion' },
          { id: 'ui', label: 'Components', group: 'Frontend' },
          { id: 'db', label: 'SQLite', group: 'Database' },
        ],
        edges: [
          { from: 'root', to: 'ui' },
          { from: 'ui', to: 'db', label: 'queries' },
        ],
      }),
    )!;
    const mermaid = buildMermaidMap(map);
    expect(mermaid.startsWith('flowchart TD')).toBe(true);
    expect(mermaid).toContain('root["companion"]');
    expect(mermaid).toContain('subgraph g0["Frontend"]');
    expect(mermaid).toContain('ui["Components"]');
    expect(mermaid).toContain('subgraph g1["Database"]');
    expect(mermaid).toContain('ui -->|queries| db');
    expect(mermaid).toContain('root --> ui');
  });

  it('sanitizes edge labels that would break mermaid syntax', () => {
    const map = parseStructuredMap(
      JSON.stringify({
        nodes: [
          { id: 'a', label: 'UI' },
          { id: 'b', label: 'Backend' },
        ],
        edges: [{ from: 'a', to: 'b', label: 'invoke(command) [x]|y|' }],
      }),
    )!;
    const mermaid = buildMermaidMap(map);
    expect(mermaid).toContain('a -->|invoke command x y| b');
    expect(mermaid).not.toContain('(command)');
  });
});

describe('mapPathsOf', () => {
  it('keeps only paths that exist', () => {
    const map = parseStructuredMap(
      JSON.stringify({
        nodes: [
          { id: 'ui', label: 'UI', path: 'src/components' },
          { id: 'api', label: 'API', path: 'src/api' },
        ],
      }),
    )!;
    expect(mapPathsOf(map, (relative) => relative === 'src/components')).toEqual({
      ui: 'src/components',
    });
  });
});
