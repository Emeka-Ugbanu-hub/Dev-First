import type { FileFacts, HandlerRecord } from '../scan/duplication';
import {
  endpointMethodsMatch,
  endpointShapesMatch,
  rustCrateRoot,
} from '../scan/crossFile';

export type ArchitectureRelationKind = 'import' | 'module' | 'tauri-command' | 'rest-endpoint';

export interface ArchitectureRelationEvidence {
  fromFile: string;
  toFile: string;
  sourceFile: string;
  line: number;
  kind: ArchitectureRelationKind;
  role: 'use site' | 'registration' | 'handler';
  symbol?: string;
  count?: number;
}

export interface ArchitectureRelation {
  fromId: string;
  toId: string;
  kind?: ArchitectureRelationKind;
  label: string;
  weight: number;
  distinct?: number;
  evidence: ArchitectureRelationEvidence[];
  evidenceTotal?: number;
}

interface RelationAccumulator extends Omit<ArchitectureRelation, 'evidence'> {
  evidence: ArchitectureRelationEvidence[];
}

const MAX_RELATION_EVIDENCE = 12;

function groupEvidence(evidence: ArchitectureRelationEvidence[]): ArchitectureRelationEvidence[] {
  const grouped = new Map<string, ArchitectureRelationEvidence>();
  for (const item of evidence) {
    const key = `${item.sourceFile}\u0000${item.role}\u0000${item.symbol ?? ''}\u0000${item.kind}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
    } else {
      grouped.set(key, { ...item, count: 1 });
    }
  }
  return [...grouped.values()].sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || a.line - b.line);
}

export function analyzeArchitectureRelations(
  facts: FileFacts[],
  nodeMap: Map<string, string>,
): ArchitectureRelation[] {
  const known = new Set(facts.map((file) => file.file));
  const pairs = new Map<string, RelationAccumulator>();
  const add = (
    fromFile: string,
    toFile: string,
    line: number,
    kind: ArchitectureRelationKind,
    label: string,
    symbol?: string,
    proofs: ArchitectureRelationEvidence[] = [],
  ): void => {
    const fromId = nodeMap.get(fromFile);
    const toId = nodeMap.get(toFile);
    if (!fromId || !toId || fromId === toId) {
      return;
    }
    const key = `${fromId}\u0000${toId}\u0000${kind}`;
    let relation = pairs.get(key);
    if (!relation) {
      relation = { fromId, toId, kind, label, weight: 0, evidence: [] };
      pairs.set(key, relation);
    }
    relation.weight++;
    relation.evidence.push({ fromFile, toFile, sourceFile: fromFile, line, kind, role: 'use site', symbol });
    relation.evidence.push(...proofs);
  };

  const rustRoots = new Map<string, string | undefined>();
  const rootOf = (file: string): string | undefined => {
    if (!rustRoots.has(file)) {
      rustRoots.set(file, rustCrateRoot(file, known));
    }
    return rustRoots.get(file);
  };
  const handlers: Array<{ file: string; handler: HandlerRecord }> = [];
  const registered = new Map<string, Array<{ file: string; line: number }>>();
  for (const file of facts) {
    for (const handler of file.handlers ?? []) {
      if (handler.method === 'IPC') {
        handlers.push({ file: file.file, handler });
      } else if (handler.pathShape) {
        handlers.push({ file: file.file, handler });
      }
    }
    for (const registration of file.tauriCommandRegistrations ?? []) {
      const crate = rootOf(file.file);
      if (crate) {
        const key = `${crate}\u0000${registration.name}`;
        const locations = registered.get(key) ?? [];
        locations.push({ file: file.file, line: registration.line });
        registered.set(key, locations);
      }
    }
  }
  for (const file of facts) {
    for (const call of file.httpCalls ?? []) {
      if (call.method !== 'IPC') {
        continue;
      }
      const targets = handlers.filter(
        ({ file: handlerFile, handler }) =>
          handler.method === 'IPC' &&
          handler.name === call.path &&
          rootOf(handlerFile) !== undefined &&
          (registered.get(`${rootOf(handlerFile)}\u0000${handler.name}`)?.length ?? 0) > 0,
      );
      for (const { file: handlerFile, handler } of targets.length === 1 ? targets : []) {
        const location = registered.get(`${rootOf(handlerFile)}\u0000${handler.name}`)?.[0];
        if (!location) continue;
        add(file.file, handlerFile, call.line, 'tauri-command', 'calls', call.path, [
          { fromFile: file.file, toFile: handlerFile, sourceFile: location.file, line: location.line, kind: 'tauri-command', role: 'registration', symbol: call.path },
          { fromFile: file.file, toFile: handlerFile, sourceFile: handlerFile, line: handler.line, kind: 'tauri-command', role: 'handler', symbol: call.path },
        ]);
      }
    }
  }

  for (const file of facts) {
    for (const call of file.httpCalls ?? []) {
      if (call.method === 'IPC' || !call.path.startsWith('/')) {
        continue;
      }
      for (const target of facts) {
        if (target.file === file.file) {
          continue;
        }
        for (const handler of target.handlers ?? []) {
          if (
            handler.pathShape &&
            endpointShapesMatch(call.pathShape, handler.pathShape) &&
            endpointMethodsMatch(call.method, handler.method)
          ) {
            add(file.file, target.file, call.line, 'rest-endpoint', 'matches endpoint', call.path, [
              { fromFile: file.file, toFile: target.file, sourceFile: target.file, line: handler.line, kind: 'rest-endpoint', role: 'handler', symbol: handler.name },
            ]);
          }
        }
      }
    }
  }

  const relations = [...pairs.values()]
    .map((relation) => {
      const grouped = groupEvidence(relation.evidence);
      const distinct = new Set(
        grouped.map((entry) => entry.symbol).filter((symbol): symbol is string => Boolean(symbol)),
      ).size;
      return {
        ...relation,
        distinct,
        evidence: grouped.slice(0, MAX_RELATION_EVIDENCE),
        evidenceTotal: grouped.length,
      };
    })
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        a.fromId.localeCompare(b.fromId) ||
        a.toId.localeCompare(b.toId),
    );
  return relations;
}

export function computeRelations(
  facts: FileFacts[],
  nodeMap: Map<string, string>,
): ArchitectureRelation[] {
  return analyzeArchitectureRelations(facts, nodeMap);
}
