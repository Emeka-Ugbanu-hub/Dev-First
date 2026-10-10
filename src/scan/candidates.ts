import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { ScanFinding, ScanRule } from './ruleTypes';

const JS_LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);

const unusedTopLevelRule: ScanRule = {
  kind: 'analyzer',
  id: 'candidate-unused-top-level-binding',
  category: 'smell',
  severity: 'info',
  run: () => [],
  message: 'Top-level binding has no references in this file.',
  why: 'This is a candidate only; workspace references and framework entry points must be checked before reporting it.',
  fix: 'Remove the binding if it is not part of a public or framework-discovered entry point.',
  confidence: 'low',
};

const duplicateTopLevelRule: ScanRule = {
  kind: 'analyzer',
  id: 'candidate-duplicate-top-level-binding',
  category: 'bug',
  severity: 'warning',
  run: () => [],
  message: 'Top-level binding is declared more than once.',
  why: 'Duplicate declarations can shadow or replace an earlier binding, but the language and build configuration must be checked before reporting it.',
  fix: 'Keep one declaration or rename the bindings so their ownership is explicit.',
  confidence: 'low',
};

function walk(node: Node, visit: (current: Node) => void): void {
  visit(node);
  for (const child of node.namedChildren.filter((item): item is Node => Boolean(item))) {
    walk(child, visit);
  }
}

function identifierCount(tree: Tree, name: string): number {
  let count = 0;
  walk(tree.rootNode, (node) => {
    if (node.type === 'identifier' && node.text === name) {
      count += 1;
    }
  });
  return count;
}

function topLevelDeclarations(tree: Tree): Node[] {
  const declarations: Node[] = [];
  for (const node of tree.rootNode.namedChildren.filter((item): item is Node => Boolean(item))) {
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      declarations.push(node);
      continue;
    }
    if (node.type === 'export_statement') {
      // Exported bindings are deliberately excluded: package exports and
      // framework discovery can make them live without local references.
      continue;
    }
  }
  return declarations;
}

export function buildCandidateSignals(tree: Tree | undefined, languageId: string): ScanFinding[] {
  if (!tree || !JS_LANGUAGES.has(languageId)) {
    return [];
  }
  const findings: ScanFinding[] = [];
  const declarations = new Map<string, Node>();
  for (const declaration of topLevelDeclarations(tree)) {
    for (const declarator of declaration.namedChildren.filter((item): item is Node => Boolean(item))) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const name = declarator.childForFieldName('name');
      if (!name || name.type !== 'identifier' || identifierCount(tree, name.text) !== 1) {
        if (name?.type === 'identifier') {
          const previous = declarations.get(name.text);
          if (previous) {
            findings.push({
              rule: duplicateTopLevelRule,
              line: name.startPosition.row,
              startChar: name.startPosition.column,
              endChar: name.endPosition.column,
            });
          } else {
            declarations.set(name.text, name);
          }
        }
        continue;
      }
      if (declarations.has(name.text)) {
        findings.push({
          rule: duplicateTopLevelRule,
          line: name.startPosition.row,
          startChar: name.startPosition.column,
          endChar: name.endPosition.column,
        });
        continue;
      }
      declarations.set(name.text, name);
      findings.push({
        rule: unusedTopLevelRule,
        line: name.startPosition.row,
        startChar: name.startPosition.column,
        endChar: name.endPosition.column,
      });
    }
  }
  return findings;
}
