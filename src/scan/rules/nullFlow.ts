import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from '../languages/profiles';
import type { RulePack, ScanRange } from '../ruleTypes';
import { nodeRange } from '../treeSitter';
import {
  SCAN_LANGUAGES,
  bodyOf,
  descendantsOf,
  functionsOf,
  isFunctionType,
  isJsLike,
  named,
  operatorOf,
  statementsOf,
} from './analyzerUtils';
import {
  capturedNames,
  containsControlFlow,
  identifierTypes,
  isStraightLine,
  parameterNameTexts,
  referencesName,
  statementContaining,
  walkStraightLine,
  withinFunction,
  writeTargets,
  writesIn,
} from './flowAnalyzers';

function isNullLiteral(node: Node | null, profile: LanguageProfile): boolean {
  if (!node) {
    return false;
  }
  if (isJsLike(profile)) {
    return node.type === 'null' || (node.type === 'identifier' && node.text === 'undefined');
  }
  if (profile.language === 'python') {
    return node.type === 'none';
  }
  if (profile.language === 'java') {
    return node.type === 'null_literal';
  }
  if (profile.language === 'go') {
    return node.type === 'nil';
  }
  if (profile.language === 'php') {
    return node.type === 'null';
  }
  return false;
}

function findDeref(node: Node, name: string, profile: LanguageProfile): Node | null {
  if (isJsLike(profile)) {
    for (const member of descendantsOf(node, ['member_expression', 'subscript_expression'])) {
      const object = member.childForFieldName('object');
      if (object?.type !== 'identifier' || object.text !== name) {
        continue;
      }
      if (member.childForFieldName('optional_chain')) {
        return null;
      }
      return member;
    }
    return null;
  }
  if (profile.language === 'python') {
    for (const access of descendantsOf(node, ['attribute', 'subscript'])) {
      const object =
        access.type === 'attribute' ? access.childForFieldName('object') : access.childForFieldName('value');
      if (object?.type === 'identifier' && object.text === name) {
        return access;
      }
    }
    return null;
  }
  if (profile.language === 'java') {
    for (const access of descendantsOf(node, ['field_access', 'array_access', 'method_invocation'])) {
      const object =
        access.type === 'array_access' ? access.childForFieldName('array') : access.childForFieldName('object');
      if (object?.type === 'identifier' && object.text === name) {
        return access;
      }
    }
    return null;
  }
  if (profile.language === 'go') {
    for (const access of descendantsOf(node, ['selector_expression', 'index_expression'])) {
      const operand = access.childForFieldName('operand');
      if (operand?.type === 'identifier' && operand.text === name) {
        return access;
      }
    }
    return null;
  }
  if (profile.language === 'php') {
    for (const access of descendantsOf(node, [
      'member_access_expression',
      'member_call_expression',
      'subscript_expression',
    ])) {
      const children = named(access, profile);
      const object = access.childForFieldName('object') ?? children[0] ?? null;
      if (object?.type === 'variable_name' && object.text === name) {
        return access;
      }
    }
    return null;
  }
  return null;
}

function nullComparison(
  node: Node,
  name: string,
  profile: LanguageProfile,
  nullTypes: string[],
  operators: string[],
): boolean {
  return descendantsOf(node, ['binary_expression']).some((binary) => {
    const operator = operatorOf(binary);
    return (
      operator !== undefined &&
      operators.includes(operator) &&
      referencesName(binary, name, profile) &&
      descendantsOf(binary, nullTypes).length > 0
    );
  });
}

function containsGuard(node: Node, name: string, profile: LanguageProfile): boolean {
  if (isJsLike(profile)) {
    for (const binary of descendantsOf(node, ['binary_expression'])) {
      const operator = operatorOf(binary);
      if (operator !== '!=' && operator !== '!==' && operator !== '??') {
        continue;
      }
      if (
        referencesName(binary, name, profile) &&
        descendantsOf(binary, ['null', 'undefined']).length > 0
      ) {
        return true;
      }
    }
    for (const member of descendantsOf(node, ['member_expression', 'subscript_expression'])) {
      const object = member.childForFieldName('object');
      if (object?.type === 'identifier' && object.text === name && member.childForFieldName('optional_chain')) {
        return true;
      }
    }
    return false;
  }
  if (profile.language === 'python') {
    return descendantsOf(node, ['comparison_operator']).some(
      (comparison) => referencesName(comparison, name, profile) && descendantsOf(comparison, ['none']).length > 0,
    );
  }
  if (profile.language === 'java') {
    return nullComparison(node, name, profile, ['null_literal'], ['==', '!=']);
  }
  if (profile.language === 'go') {
    return nullComparison(node, name, profile, ['nil'], ['==', '!=']);
  }
  if (profile.language === 'php') {
    return nullComparison(node, name, profile, ['null'], ['==', '!=', '===', '!==']);
  }
  return false;
}

function nullDeref(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (!body || isFunctionType(body.type, profile)) {
      continue;
    }
    const captured = capturedNames(body, profile);
    for (const write of writesIn(body, profile)) {
      if (!isNullLiteral(write.value, profile) || captured.has(write.name)) {
        continue;
      }
      if (!isStraightLine(write.statement, body, profile)) {
        continue;
      }
      let deref: Node | null = null;
      const outcome = walkStraightLine(write.statement, body, profile, (sibling) => {
        if (containsGuard(sibling, write.name, profile)) {
          return 'unknown';
        }
        const found = findDeref(sibling, write.name, profile);
        if (found) {
          deref = found;
          return 'hit';
        }
        if (referencesName(sibling, write.name, profile)) {
          return 'unknown';
        }
        if (containsControlFlow(sibling, profile)) {
          return 'unknown';
        }
        return 'continue';
      });
      if (outcome === 'hit' && deref !== null) {
        out.push(nodeRange(deref));
      }
    }
  }
  return out;
}

interface Declaration {
  name: string;
  statement: Node;
  list: Node;
}

function declarationContainers(profile: LanguageProfile): string[] {
  if (isJsLike(profile)) {
    return ['lexical_declaration'];
  }
  if (profile.language === 'python') {
    return ['assignment'];
  }
  if (profile.language === 'java') {
    return ['local_variable_declaration'];
  }
  if (profile.language === 'go') {
    return ['short_var_declaration', 'var_declaration'];
  }
  if (profile.language === 'php') {
    return ['assignment_expression'];
  }
  return [];
}

function collectDeclarations(body: Node, profile: LanguageProfile): Map<string, Declaration[]> {
  const out = new Map<string, Declaration[]>();
  for (const container of withinFunction(body, declarationContainers(profile), profile)) {
    const located = statementContaining(container, profile);
    if (!located) {
      continue;
    }
    if (located.statement.id !== container.id && located.statement.type !== 'expression_statement') {
      continue;
    }
    for (const target of writeTargets(container, profile)) {
      const entries = out.get(target.name) ?? [];
      entries.push({
        name: target.name,
        statement: located.statement,
        list: located.list,
      });
      out.set(target.name, entries);
    }
  }
  return out;
}

function globalNames(body: Node, profile: LanguageProfile): Set<string> {
  const out = new Set<string>();
  for (const statement of descendantsOf(body, ['global_statement'])) {
    for (const id of descendantsOf(statement, identifierTypes(profile))) {
      out.add(id.text);
    }
  }
  return out;
}

function isCallCallee(id: Node, profile: LanguageProfile): boolean {
  const parent = id.parent;
  if (!parent) {
    return false;
  }
  if (isJsLike(profile)) {
    if (parent.type === 'call_expression' && parent.childForFieldName('function')?.id === id.id) {
      return true;
    }
    return parent.type === 'new_expression' && parent.childForFieldName('constructor')?.id === id.id;
  }
  if (profile.language === 'python') {
    return parent.type === 'call' && parent.childForFieldName('function')?.id === id.id;
  }
  if (profile.language === 'java') {
    return parent.type === 'method_invocation' && parent.childForFieldName('name')?.id === id.id;
  }
  if (profile.language === 'go') {
    return parent.type === 'call_expression' && parent.childForFieldName('function')?.id === id.id;
  }
  if (profile.language === 'php') {
    return parent.type === 'function_call_expression' && parent.childForFieldName('function')?.id === id.id;
  }
  return false;
}

function isTypeofOperand(id: Node, profile: LanguageProfile): boolean {
  if (!isJsLike(profile)) {
    return false;
  }
  const parent = id.parent;
  return parent?.type === 'unary_expression' && operatorOf(parent) === 'typeof';
}

function readsOfName(node: Node, name: string, profile: LanguageProfile): Node[] {
  const out: Node[] = [];
  for (const id of withinFunction(node, identifierTypes(profile), profile)) {
    if (id.text !== name || isCallCallee(id, profile) || isTypeofOperand(id, profile)) {
      continue;
    }
    out.push(id);
  }
  return out;
}

function useBeforeDefinition(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (!body || isFunctionType(body.type, profile)) {
      continue;
    }
    const params = parameterNameTexts(fn, profile);
    const globals = globalNames(body, profile);
    for (const [name, entries] of collectDeclarations(body, profile)) {
      if (params.has(name) || globals.has(name) || entries.length !== 1) {
        continue;
      }
      const entry = entries[0];
      const siblings = statementsOf(entry.list, profile);
      const index = siblings.findIndex((sibling) => sibling.id === entry.statement.id);
      if (index <= 0) {
        continue;
      }
      for (let i = 0; i < index; i++) {
        for (const read of readsOfName(siblings[i], name, profile)) {
          out.push(nodeRange(read));
        }
      }
    }
  }
  return out;
}

export const nullFlowPack: RulePack = {
  id: 'null-flow',
  languages: SCAN_LANGUAGES,
  rules: [
    {
      kind: 'analyzer',
      id: 'an-null-deref',
      category: 'bug',
      severity: 'warning',
      languages: SCAN_LANGUAGES,
      run: nullDeref,
      message: 'Variable known to be null is dereferenced.',
      why: 'The variable is assigned null and never reassigned or guarded before this access, so it throws at runtime.',
      fix: 'Guard the access with a null check or assign a non-null value first.',
    },
    {
      kind: 'analyzer',
      id: 'an-use-before-definition',
      category: 'bug',
      severity: 'warning',
      languages: SCAN_LANGUAGES,
      run: useBeforeDefinition,
      message: 'Variable is read before its declaration.',
      why: 'Reading a block-scoped or local variable before its declaration throws or yields an undefined value.',
      fix: 'Move the declaration before the first read or reorder the statements.',
    },
  ],
};
