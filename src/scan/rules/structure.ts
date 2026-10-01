import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from '../languages/profiles';
import type { RulePack, ScanRange } from '../ruleTypes';
import { nodeRange } from '../treeSitter';
import {
  SCAN_LANGUAGES,
  bodyOf,
  descendantsOf,
  descendantsWithin,
  functionsOf,
  isJsLike,
  named,
  operatorOf,
  parametersOf,
  statementsOf,
} from './analyzerUtils';

const CLASS_LANGUAGES = [
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'python',
  'java',
  'php',
];
const BOOLEAN_LANGUAGES = ['typescript', 'typescriptreact', 'java', 'python'];
const PRIVATE_LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'java'];
const IMPORT_LANGUAGES = ['java', 'python', 'go'];
const JAVA = ['java'];

const METHOD_LIMIT = 20;
const FIELD_LIMIT = 15;
const BOOLEAN_PARAM_LIMIT = 2;
const BREAK_LIMIT = 4;
const CASE_LIMIT = 15;
const MIN_PRIVATE_NAME = 3;

function classesOf(tree: Tree, profile: LanguageProfile): Node[] {
  return profile.classNode.length === 0 ? [] : descendantsOf(tree.rootNode, profile.classNode);
}

function tooManyMethods(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const classNode of classesOf(tree, profile)) {
    const body = classNode.childForFieldName('body');
    if (body && methodCount(body, profile) > METHOD_LIMIT) {
      out.push(nodeRange(classNode));
    }
  }
  return out;
}

function methodCount(body: Node, profile: LanguageProfile): number {
  if (profile.language === 'python') {
    return named(body, profile).filter(
      (child) =>
        child.type === 'function_definition' && child.childForFieldName('name')?.text !== '__init__',
    ).length;
  }
  if (profile.language === 'java') {
    return named(body, profile).filter((child) => child.type === 'method_declaration').length;
  }
  if (profile.language === 'php') {
    return named(body, profile).filter(
      (child) =>
        child.type === 'method_declaration' && child.childForFieldName('name')?.text !== '__construct',
    ).length;
  }
  return named(body, profile).filter(
    (child) =>
      child.type === 'method_definition' && child.childForFieldName('name')?.text !== 'constructor',
  ).length;
}

function tooManyFields(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const classNode of classesOf(tree, profile)) {
    const body = classNode.childForFieldName('body');
    if (body && fieldCount(body, profile) > FIELD_LIMIT) {
      out.push(nodeRange(classNode));
    }
  }
  return out;
}

function fieldCount(body: Node, profile: LanguageProfile): number {
  if (profile.language === 'python') {
    return named(body, profile).filter(
      (child) =>
        child.type === 'expression_statement' && child.namedChildren[0]?.type === 'assignment',
    ).length;
  }
  if (profile.language === 'java') {
    return named(body, profile).filter((child) => child.type === 'field_declaration').length;
  }
  if (profile.language === 'php') {
    return named(body, profile).filter((child) => child.type === 'property_declaration').length;
  }
  return named(body, profile).filter(
    (child) => child.type === 'public_field_definition' || child.type === 'field_definition',
  ).length;
}

function booleanParams(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const params = parametersOf(fn);
    if (params && booleanParamCount(params, profile) >= BOOLEAN_PARAM_LIMIT) {
      out.push(nodeRange(fn));
    }
  }
  return out;
}

function booleanParamCount(params: Node, profile: LanguageProfile): number {
  if (profile.language === 'java') {
    return named(params, profile).filter(
      (child) =>
        child.type === 'formal_parameter' && child.childForFieldName('type')?.type === 'boolean_type',
    ).length;
  }
  if (profile.language === 'python') {
    return named(params, profile).filter((child) => pythonParamIsBoolean(child)).length;
  }
  return named(params, profile).filter((child) => tsParamIsBoolean(child)).length;
}

function pythonParamIsBoolean(node: Node): boolean {
  if (node.type !== 'typed_parameter' && node.type !== 'typed_default_parameter') {
    return false;
  }
  return node.childForFieldName('type')?.text.trim() === 'bool';
}

function tsParamIsBoolean(node: Node): boolean {
  if (node.type !== 'required_parameter' && node.type !== 'optional_parameter') {
    return false;
  }
  const type = node.childForFieldName('type');
  return type ? type.text.replace(/^:\s*/, '').trim() === 'boolean' : false;
}

function tooManyBreaks(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (!body || !isBlockLike(body, profile)) {
      continue;
    }
    const jumps = descendantsWithin(body, [profile.breakNode, profile.continueNode], profile).length;
    if (jumps > BREAK_LIMIT) {
      out.push(nodeRange(fn));
    }
  }
  return out;
}

function isBlockLike(node: Node, profile: LanguageProfile): boolean {
  return profile.blockNode.includes(node.type) || node.type === profile.statementListNode;
}

function oversizedSwitch(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const node of descendantsOf(tree.rootNode, [profile.switchNode])) {
    if (switchCaseCount(node, profile) > CASE_LIMIT) {
      out.push(nodeRange(node));
    }
  }
  return out;
}

function switchCaseCount(node: Node, profile: LanguageProfile): number {
  const body = node.childForFieldName('body');
  if (profile.language === 'java') {
    let count = 0;
    for (const group of body ? named(body, profile) : []) {
      if (group.type !== 'switch_block_statement_group') {
        continue;
      }
      for (const label of named(group, profile)) {
        if (label.type === 'switch_label' && label.namedChildren.some((child) => child !== null)) {
          count++;
        }
      }
    }
    return count;
  }
  if (profile.language === 'go') {
    return named(node, profile).filter((child) => child.type === profile.caseNode).length;
  }
  return named(body ?? node, profile).filter((child) => child.type === profile.caseNode).length;
}

function unusedPrivateMember(
  tree: Tree,
  profile: LanguageProfile,
  text: string,
): ScanRange[] {
  const out: ScanRange[] = [];
  for (const classNode of classesOf(tree, profile)) {
    const body = classNode.childForFieldName('body');
    if (!body) {
      continue;
    }
    for (const name of privateNames(body, profile)) {
      const raw = name.text;
      const plain = raw.startsWith('#') ? raw.slice(1) : raw;
      if (plain.length < MIN_PRIVATE_NAME) {
        continue;
      }
      if (isReferencedOutside(text, raw, name.startIndex, name.endIndex)) {
        continue;
      }
      out.push(nodeRange(name));
    }
  }
  return out;
}

function privateNames(body: Node, profile: LanguageProfile): Node[] {
  return isJsLike(profile) ? privateJsNames(body, profile) : privateJavaNames(body, profile);
}

function privateJavaNames(body: Node, profile: LanguageProfile): Node[] {
  const out: Node[] = [];
  for (const member of named(body, profile)) {
    if (!hasJavaPrivateModifier(member)) {
      continue;
    }
    if (member.type === 'method_declaration') {
      const name = member.childForFieldName('name');
      if (name) {
        out.push(name);
      }
    } else if (member.type === 'field_declaration') {
      for (const declarator of named(member, profile)) {
        if (declarator.type !== 'variable_declarator') {
          continue;
        }
        const name = declarator.childForFieldName('name');
        if (name) {
          out.push(name);
        }
      }
    }
  }
  return out;
}

function hasJavaPrivateModifier(member: Node): boolean {
  const modifiers = member.children.find((child) => child?.type === 'modifiers');
  return modifiers ? modifiers.text.split(/\s+/).includes('private') : false;
}

function privateJsNames(body: Node, profile: LanguageProfile): Node[] {
  const out: Node[] = [];
  for (const member of named(body, profile)) {
    if (member.type === 'method_definition') {
      const name = member.childForFieldName('name');
      if (!name || name.text === 'constructor') {
        continue;
      }
      if (hasPrivateAccessibility(member) || name.type === 'private_property_identifier') {
        out.push(name);
      }
    } else if (member.type === 'public_field_definition' || member.type === 'field_definition') {
      const name = member.childForFieldName('name') ?? member.childForFieldName('property');
      if (!name) {
        continue;
      }
      if (hasPrivateAccessibility(member) || name.type === 'private_property_identifier') {
        out.push(name);
      }
    }
  }
  return out;
}

function hasPrivateAccessibility(member: Node): boolean {
  const modifier = member.children.find((child) => child?.type === 'accessibility_modifier');
  return modifier ? modifier.text === 'private' : false;
}

function isReferencedOutside(text: string, name: string, start: number, end: number): boolean {
  let index = text.indexOf(name);
  while (index !== -1) {
    if (index < start || index >= end) {
      return true;
    }
    index = text.indexOf(name, index + 1);
  }
  return false;
}

function emptyMethod(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (!body || !isBlockLike(body, profile) || isOverride(fn, profile)) {
      continue;
    }
    const statements = statementsOf(body, profile);
    if (statements.length === 0 || isPassOnly(statements, profile)) {
      out.push(nodeRange(fn));
    }
  }
  return out;
}

function isPassOnly(statements: Node[], profile: LanguageProfile): boolean {
  return (
    profile.language === 'python' &&
    statements.length === 1 &&
    statements[0].type === 'pass_statement'
  );
}

function isOverride(fn: Node, profile: LanguageProfile): boolean {
  if (profile.language === 'java') {
    const modifiers = fn.children.find((child) => child?.type === 'modifiers');
    return modifiers ? modifiers.text.includes('@Override') : false;
  }
  if (profile.language === 'python') {
    return fn.parent?.type === 'decorated_definition';
  }
  if (profile.language === 'typescript') {
    return fn.children.some((child) => child?.type === 'override_modifier');
  }
  return false;
}

function negatedCondition(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const node of descendantsOf(tree.rootNode, [profile.ifNode])) {
    if (node.childForFieldName(profile.elseField)) {
      continue;
    }
    const condition = node.childForFieldName('condition');
    if (condition && isNegated(condition, profile)) {
      out.push(nodeRange(condition));
    }
  }
  return out;
}

function isNegated(condition: Node, profile: LanguageProfile): boolean {
  const inner = named(condition, profile)[0];
  if (profile.language === 'python') {
    if (condition.type === 'not_operator') {
      return inner?.type === 'parenthesized_expression';
    }
    return condition.type === 'parenthesized_expression' && inner?.type === 'not_operator';
  }
  if (!inner || (inner.type !== 'unary_expression' && inner.type !== 'unary_op_expression')) {
    return false;
  }
  if (operatorOf(inner) !== '!') {
    return false;
  }
  return named(inner, profile)[0]?.type === 'parenthesized_expression';
}

interface ImportEntry {
  node: Node;
  key: string;
  startLine: number;
  endLine: number;
}

function importOrdering(tree: Tree, profile: LanguageProfile, text: string): ScanRange[] {
  const entries = importEntries(tree, profile);
  if (entries.length === 0) {
    return [];
  }
  const lines = text.split('\n');
  let groupStart = 0;
  for (let i = 1; i < entries.length; i++) {
    if (hasBlankLine(lines, entries[i - 1].endLine, entries[i].startLine)) {
      const hit = firstOutOfOrder(entries, groupStart, i);
      if (hit) {
        return [nodeRange(hit.node)];
      }
      groupStart = i;
    }
  }
  const hit = firstOutOfOrder(entries, groupStart, entries.length);
  return hit ? [nodeRange(hit.node)] : [];
}

function importEntries(tree: Tree, profile: LanguageProfile): ImportEntry[] {
  const out: ImportEntry[] = [];
  const add = (node: Node): void => {
    out.push({
      node,
      key: node.text.replace(/\s+/g, ' ').trim().toLowerCase(),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
    });
  };
  if (profile.language === 'java') {
    for (const node of named(tree.rootNode, profile)) {
      if (node.type === 'import_declaration') {
        add(node);
      }
    }
  } else if (profile.language === 'python') {
    for (const node of named(tree.rootNode, profile)) {
      if (node.type === 'import_statement' || node.type === 'import_from_statement') {
        add(node);
      }
    }
  } else if (profile.language === 'go') {
    for (const declaration of descendantsOf(tree.rootNode, ['import_declaration'])) {
      for (const child of named(declaration, profile)) {
        if (child.type === 'import_spec') {
          add(child);
        } else if (child.type === 'import_spec_list') {
          for (const spec of named(child, profile)) {
            if (spec.type === 'import_spec') {
              add(spec);
            }
          }
        }
      }
    }
  }
  return out;
}

function hasBlankLine(lines: string[], previousEnd: number, nextStart: number): boolean {
  for (let line = previousEnd + 1; line < nextStart; line++) {
    if ((lines[line] ?? '').trim() === '') {
      return true;
    }
  }
  return false;
}

function firstOutOfOrder(entries: ImportEntry[], from: number, to: number): ImportEntry | undefined {
  for (let i = from + 1; i < to; i++) {
    if (entries[i].key < entries[i - 1].key) {
      return entries[i];
    }
  }
  return undefined;
}

function memberOrdering(tree: Tree, profile: LanguageProfile): ScanRange[] {
  if (profile.language !== 'java') {
    return [];
  }
  const out: ScanRange[] = [];
  for (const classNode of descendantsOf(tree.rootNode, ['class_declaration'])) {
    const body = classNode.childForFieldName('body');
    if (!body) {
      continue;
    }
    let maxRank = -1;
    for (const member of named(body, profile)) {
      const rank = memberRank(member.type);
      if (rank < 0) {
        continue;
      }
      if (rank < maxRank) {
        out.push(nodeRange(member));
        break;
      }
      if (rank > maxRank) {
        maxRank = rank;
      }
    }
  }
  return out;
}

function memberRank(type: string): number {
  if (type === 'field_declaration') {
    return 0;
  }
  if (type === 'constructor_declaration') {
    return 1;
  }
  if (type === 'method_declaration') {
    return 2;
  }
  return -1;
}

export const structurePack: RulePack = {
  id: 'structure',
  languages: SCAN_LANGUAGES,
  rules: [
    {
      kind: 'analyzer',
      id: 'an-too-many-methods',
      category: 'smell',
      severity: 'info',
      languages: CLASS_LANGUAGES,
      run: tooManyMethods,
      message: 'Class has too many methods.',
      why: 'A class with many methods usually carries more than one responsibility and is hard to navigate and test.',
      fix: 'Split the class into smaller classes grouped by responsibility.',
    },
    {
      kind: 'analyzer',
      id: 'an-too-many-fields',
      category: 'smell',
      severity: 'info',
      languages: CLASS_LANGUAGES,
      run: tooManyFields,
      message: 'Class has too many fields.',
      why: 'Many fields suggest a data clump or a class that tracks unrelated state.',
      fix: 'Group related fields into a value object or split the class.',
    },
    {
      kind: 'analyzer',
      id: 'an-boolean-params',
      category: 'smell',
      severity: 'info',
      languages: BOOLEAN_LANGUAGES,
      run: booleanParams,
      message: 'Function has multiple boolean parameters.',
      why: 'Several boolean flags make call sites unreadable and hide the intended behavior.',
      fix: 'Replace the flags with an options object or separate functions.',
    },
    {
      kind: 'analyzer',
      id: 'an-too-many-breaks',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: tooManyBreaks,
      message: 'Function has too many break or continue statements.',
      why: 'Many jumps make the loop control flow hard to follow.',
      fix: 'Extract the loop body into a helper or use early exits.',
    },
    {
      kind: 'analyzer',
      id: 'an-oversized-switch',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: oversizedSwitch,
      message: 'Switch has too many cases.',
      why: 'A switch with many cases is hard to read and often indicates a missing dispatch table or polymorphism.',
      fix: 'Replace the switch with a map or split it into smaller handlers.',
    },
    {
      kind: 'analyzer',
      id: 'an-unused-private-member',
      category: 'smell',
      severity: 'info',
      languages: PRIVATE_LANGUAGES,
      run: unusedPrivateMember,
      message: 'Private member is never used.',
      why: 'An unused private member is dead code that adds maintenance cost.',
      fix: 'Remove the member or start using it.',
    },
    {
      kind: 'analyzer',
      id: 'an-empty-method',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: emptyMethod,
      message: 'Function body is empty.',
      why: 'An empty body is dead code and often a forgotten implementation.',
      fix: 'Implement the body or remove the function.',
    },
    {
      kind: 'analyzer',
      id: 'an-negated-condition',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: negatedCondition,
      message: 'Condition is a redundant negation.',
      why: 'Negating a parenthesized condition adds noise and can be inverted for clarity.',
      fix: 'Invert the condition and swap the branches.',
    },
    {
      kind: 'analyzer',
      id: 'an-import-ordering',
      category: 'smell',
      severity: 'info',
      languages: IMPORT_LANGUAGES,
      run: importOrdering,
      message: 'Imports are not sorted.',
      why: 'Unsorted imports make it harder to scan for duplicates and missing dependencies.',
      fix: 'Sort the imports case-insensitively within each group.',
    },
    {
      kind: 'analyzer',
      id: 'an-member-ordering',
      category: 'smell',
      severity: 'info',
      languages: JAVA,
      run: memberOrdering,
      message: 'Class members are out of order.',
      why: 'Mixed member order makes a class harder to read and review.',
      fix: 'Declare fields first, then constructors, then methods.',
    },
  ],
};
