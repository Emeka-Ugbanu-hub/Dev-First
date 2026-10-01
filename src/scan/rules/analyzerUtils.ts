import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from '../languages/profiles';

export const SCAN_LANGUAGES = [
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'python',
  'java',
  'go',
  'php',
];

export function named(node: Node, profile: LanguageProfile): Node[] {
  const out: Node[] = [];
  for (const child of node.namedChildren) {
    if (child && !profile.commentNode.includes(child.type)) {
      out.push(child);
    }
  }
  return out;
}

export function descendantsOf(node: Node, types: string[]): Node[] {
  return node.descendantsOfType(types).filter((child): child is Node => child !== null);
}

export function descendantsWithin(node: Node, types: string[], profile: LanguageProfile): Node[] {
  const out: Node[] = [];
  const visit = (current: Node, root: boolean): void => {
    for (const child of named(current, profile)) {
      if (!root && isFunctionType(child.type, profile)) {
        continue;
      }
      if (types.includes(child.type)) {
        out.push(child);
      }
      visit(child, false);
    }
  };
  visit(node, true);
  return out;
}

export function functionsOf(tree: Tree, profile: LanguageProfile): Node[] {
  return descendantsOf(tree.rootNode, profile.functionNodes);
}

export function isFunctionType(type: string, profile: LanguageProfile): boolean {
  return profile.functionNodes.includes(type);
}

export function bodyOf(node: Node): Node | null {
  return node.childForFieldName('body');
}

export function parametersOf(node: Node): Node | null {
  return node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
}

export function statementsOf(block: Node, profile: LanguageProfile): Node[] {
  const children = named(block, profile);
  if (
    profile.statementListNode &&
    children.length === 1 &&
    children[0].type === profile.statementListNode
  ) {
    return named(children[0], profile);
  }
  return children;
}

export function normalizedStatement(node: Node, profile: LanguageProfile): string {
  let out = '';
  for (const child of node.children) {
    if (!child || profile.commentNode.includes(child.type)) {
      continue;
    }
    if (child.childCount === 0) {
      out += profile.identifierNode.includes(child.type) ? 'ID' : child.text.replace(/\s+/g, '');
    } else {
      out += normalizedStatement(child, profile);
    }
  }
  return out;
}

export function operatorOf(node: Node): string | undefined {
  for (const child of node.children) {
    if (child && !child.isNamed) {
      return child.type;
    }
  }
  return undefined;
}

export function isCatchNode(type: string): boolean {
  return type === 'catch_clause' || type === 'except_clause';
}

export function isTrueLiteral(node: Node | null, profile: LanguageProfile): boolean {
  if (!node) {
    return false;
  }
  return profile.trueLiteral.includes(node.type) || (node.type === 'boolean' && node.text === 'true');
}

export function isFalseLiteral(node: Node | null, profile: LanguageProfile): boolean {
  if (!node) {
    return false;
  }
  if (profile.falseLiteral.includes(node.type) || (node.type === 'boolean' && node.text === 'false')) {
    return true;
  }
  return (node.type === 'identifier' || node.type === 'name') && node.text === 'False';
}

export function isJsLike(profile: LanguageProfile): boolean {
  return profile.language === 'javascript' || profile.language === 'typescript';
}

export function isSplatNode(type: string): boolean {
  return type.includes('splat') || type.includes('spread');
}

export function stringContent(node: Node): string {
  const fragments = descendantsOf(node, ['string_fragment', 'string_content']);
  if (fragments.length === 0) {
    return '';
  }
  return fragments.map((fragment) => fragment.text).join('');
}
