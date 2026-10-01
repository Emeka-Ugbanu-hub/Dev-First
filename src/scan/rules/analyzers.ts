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
  isCatchNode,
  isFalseLiteral,
  isFunctionType,
  isJsLike,
  isSplatNode,
  isTrueLiteral,
  named,
  normalizedStatement,
  operatorOf,
  parametersOf,
  statementsOf,
  stringContent,
} from './analyzerUtils';

const COMPLEXITY_LIMIT = 15;
const NESTING_LIMIT = 4;
const FUNCTION_LINE_LIMIT = 80;
const PARAM_LIMIT = 7;
const RETURN_LIMIT = 6;
const DUPLICATED_STATEMENTS = 6;

function cognitiveComplexity(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (body && !isFunctionType(body.type, profile) && complexity(body, profile, 0) > COMPLEXITY_LIMIT) {
      out.push(nodeRange(fn));
    }
  }
  return out;
}

function complexity(node: Node, profile: LanguageProfile, nesting: number): number {
  let score = 0;
  for (const child of named(node, profile)) {
    if (isFunctionType(child.type, profile)) {
      continue;
    }
    score += decisionScore(child, profile, nesting);
    const next = child.type === 'else_clause' ? nesting : nestingFor(child, profile, nesting);
    score += complexity(child, profile, next);
  }
  return score;
}

function decisionScore(node: Node, profile: LanguageProfile, nesting: number): number {
  if (node.type === profile.ifNode || (profile.elseIfNode && node.type === profile.elseIfNode)) {
    return 1 + nesting;
  }
  if (profile.loopNodes.includes(node.type)) {
    return 1 + nesting;
  }
  if (profile.ternaryNode && node.type === profile.ternaryNode) {
    return 1 + nesting;
  }
  if (isCatchNode(node.type)) {
    return 1 + nesting;
  }
  if (node.type === profile.caseNode) {
    return 1;
  }
  return isBooleanOperator(node, profile) ? 1 : 0;
}

function nestingFor(node: Node, profile: LanguageProfile, nesting: number): number {
  if (
    node.type === profile.ifNode ||
    (profile.elseIfNode && node.type === profile.elseIfNode) ||
    profile.loopNodes.includes(node.type) ||
    isCatchNode(node.type) ||
    node.type === profile.switchNode
  ) {
    return nesting + 1;
  }
  return nesting;
}

function isBooleanOperator(node: Node, profile: LanguageProfile): boolean {
  if (!profile.binaryNode.includes(node.type)) {
    return false;
  }
  const operator = operatorOf(node);
  return operator === '&&' || operator === '||' || operator === 'and' || operator === 'or';
}

function deepNesting(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (body && !isFunctionType(body.type, profile) && maxBlockDepth(body, profile, 0) > NESTING_LIMIT) {
      out.push(nodeRange(fn));
    }
  }
  return out;
}

function maxBlockDepth(node: Node, profile: LanguageProfile, depth: number): number {
  let max = depth;
  for (const child of named(node, profile)) {
    if (isFunctionType(child.type, profile)) {
      continue;
    }
    const next = profile.blockNode.includes(child.type) ? depth + 1 : depth;
    const inner = maxBlockDepth(child, profile, next);
    if (inner > max) {
      max = inner;
    }
  }
  return max;
}

function longFunction(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    if (fn.endPosition.row - fn.startPosition.row + 1 > FUNCTION_LINE_LIMIT) {
      out.push(nodeRange(fn));
    }
  }
  return out;
}

function tooManyParams(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const params = parametersOf(fn);
    if (params && parameterCount(params, profile) > PARAM_LIMIT) {
      out.push(nodeRange(params));
    }
  }
  return out;
}

function parameterCount(params: Node, profile: LanguageProfile): number {
  if (profile.language === 'go') {
    let count = 0;
    for (const declaration of named(params, profile)) {
      const names = declaration.childrenForFieldName('name').filter((name) => name !== null);
      count += names.length > 0 ? names.length : 1;
    }
    return count;
  }
  const nodes = named(params, profile).filter(
    (node) => node.type !== 'positional_separator' && node.type !== 'keyword_separator',
  );
  return nodes.length;
}

function tooManyReturns(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (body && !isFunctionType(body.type, profile) && countReturns(body, profile) > RETURN_LIMIT) {
      out.push(nodeRange(fn));
    }
  }
  return out;
}

function countReturns(node: Node, profile: LanguageProfile): number {
  let count = 0;
  for (const child of named(node, profile)) {
    if (isFunctionType(child.type, profile)) {
      continue;
    }
    if (child.type === profile.returnNode) {
      count++;
    }
    count += countReturns(child, profile);
  }
  return count;
}

interface LocalName {
  name: Node;
  searchTypes: string[];
}

function unusedLocal(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (!body) {
      continue;
    }
    for (const entry of localDeclarations(body, profile)) {
      if (!isReferenced(entry.name, body, entry.searchTypes)) {
        out.push(nodeRange(entry.name));
      }
    }
  }
  return out;
}

function localDeclarations(body: Node, profile: LanguageProfile): LocalName[] {
  const language = profile.language;
  const searchTypes =
    language === 'php'
      ? ['variable_name']
      : language === 'javascript' || language === 'typescript'
        ? ['identifier', 'shorthand_property_identifier']
        : ['identifier'];
  const out: LocalName[] = [];
  for (const node of descendantsWithin(body, declarationTypes(language), profile)) {
    for (const name of declarationNames(node, profile)) {
      if (name.text.startsWith('_')) {
        continue;
      }
      out.push({ name, searchTypes });
    }
  }
  return out;
}

function declarationTypes(language: string): string[] {
  if (language === 'javascript' || language === 'typescript') {
    return ['lexical_declaration', 'variable_declaration'];
  }
  if (language === 'python') {
    return ['assignment'];
  }
  if (language === 'java') {
    return ['local_variable_declaration'];
  }
  if (language === 'go') {
    return ['short_var_declaration', 'var_declaration'];
  }
  if (language === 'php') {
    return ['assignment_expression'];
  }
  return [];
}

function declarationNames(node: Node, profile: LanguageProfile): Node[] {
  const language = profile.language;
  if (language === 'javascript' || language === 'typescript') {
    return named(node, profile)
      .filter((child) => child.type === 'variable_declarator')
      .map((child) => child.childForFieldName('name'))
      .filter((name): name is Node => name !== null && name.type === 'identifier');
  }
  if (language === 'python') {
    const left = node.childForFieldName('left');
    return left && left.type === 'identifier' ? [left] : [];
  }
  if (language === 'java') {
    return named(node, profile)
      .filter((child) => child.type === 'variable_declarator')
      .map((child) => child.childForFieldName('name'))
      .filter((name): name is Node => name !== null);
  }
  if (language === 'go') {
    const names: Node[] = [];
    if (node.type === 'short_var_declaration') {
      const left = node.childForFieldName('left');
      if (left) {
        names.push(...named(left, profile).filter((child) => child.type === 'identifier'));
      }
    } else {
      for (const spec of named(node, profile)) {
        if (spec.type !== 'var_spec') {
          continue;
        }
        for (const child of spec.childrenForFieldName('name')) {
          if (child && child.type === 'identifier') {
            names.push(child);
          }
        }
      }
    }
    return names;
  }
  if (language === 'php') {
    const left = node.childForFieldName('left');
    if (!left || left.type !== 'variable_name' || left.text === '$this') {
      return [];
    }
    return [left];
  }
  return [];
}

function isReferenced(name: Node, body: Node, types: string[]): boolean {
  for (const node of descendantsOf(body, types)) {
    if (node.id !== name.id && node.text === name.text) {
      return true;
    }
  }
  return false;
}

function unusedParam(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (!body || isOverride(fn, profile)) {
      continue;
    }
    const params = parametersOf(fn);
    if (!params) {
      continue;
    }
    const searchTypes = profile.language === 'php' ? ['variable_name'] : ['identifier'];
    for (const name of parameterNames(params, profile)) {
      const raw = profile.language === 'php' ? (name.childForFieldName('name')?.text ?? name.text) : name.text;
      if (raw === 'self' || raw === 'cls' || raw === 'this' || raw === '$this' || raw.startsWith('_')) {
        continue;
      }
      if (!isReferenced(name, body, searchTypes)) {
        out.push(nodeRange(name));
      }
    }
  }
  return out;
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

function parameterNames(params: Node, profile: LanguageProfile): Node[] {
  const language = profile.language;
  if (language === 'javascript' || language === 'typescript') {
    return jsParameterNames(params);
  }
  if (language === 'python') {
    return pythonParameterNames(params);
  }
  if (language === 'java' || language === 'php') {
    return named(params, profile)
      .map((child) => child.childForFieldName('name'))
      .filter((name): name is Node => name !== null);
  }
  if (language === 'go') {
    const names: Node[] = [];
    for (const declaration of named(params, profile)) {
      for (const name of declaration.childrenForFieldName('name')) {
        if (name) {
          names.push(name);
        }
      }
    }
    return names;
  }
  return [];
}

function jsParameterNames(params: Node): Node[] {
  if (params.type === 'identifier') {
    return [params];
  }
  const names: Node[] = [];
  for (const child of params.namedChildren) {
    if (!child) {
      continue;
    }
    const name = jsParameterName(child);
    if (name) {
      names.push(name);
    }
  }
  return names;
}

function jsParameterName(node: Node): Node | null {
  if (node.type === 'identifier') {
    return node;
  }
  if (node.type === 'rest_pattern' || node.type === 'spread_element') {
    return node.namedChildren.find((child): child is Node => child?.type === 'identifier') ?? null;
  }
  const inner =
    node.childForFieldName('pattern') ??
    node.childForFieldName('left') ??
    node.childForFieldName('name');
  return inner ? jsParameterName(inner) : null;
}

function pythonParameterNames(params: Node): Node[] {
  if (params.type === 'identifier') {
    return [params];
  }
  const names: Node[] = [];
  for (const child of params.namedChildren) {
    if (!child || child.type === 'positional_separator' || child.type === 'keyword_separator') {
      continue;
    }
    const name =
      child.type === 'identifier'
        ? child
        : (child.childForFieldName('name') ??
          child.namedChildren.find((nested): nested is Node => nested?.type === 'identifier') ??
          null);
    if (name) {
      names.push(name);
    }
  }
  return names;
}

function duplicatedBlock(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  const seen = new Map<string, Node>();
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (!body) {
      continue;
    }
    const statements = statementsOf(body, profile);
    if (statements.length < DUPLICATED_STATEMENTS) {
      continue;
    }
    const key = statements.map((statement) => normalizedStatement(statement, profile)).join('\n');
    if (!key) {
      continue;
    }
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, fn);
      continue;
    }
    if (!isAncestor(previous, fn)) {
      out.push(nodeRange(body));
    }
  }
  return out;
}

function isAncestor(node: Node, other: Node): boolean {
  let current = other.parent;
  while (current) {
    if (current.id === node.id) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function formatStringMismatch(tree: Tree, profile: LanguageProfile): ScanRange[] {
  if (profile.language === 'java') {
    return javaFormatMismatch(tree, profile);
  }
  if (profile.language === 'python') {
    return pythonFormatMismatch(tree, profile);
  }
  return [];
}

function javaFormatMismatch(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const call of descendantsOf(tree.rootNode, ['method_invocation'])) {
    const name = call.childForFieldName('name')?.text;
    const object = call.childForFieldName('object');
    if (name !== 'format' && name !== 'printf') {
      continue;
    }
    if (name === 'format' && object?.text !== 'String') {
      continue;
    }
    if (name === 'printf' && object && !object.text.endsWith('out')) {
      continue;
    }
    const args = call.childForFieldName('arguments');
    if (!args) {
      continue;
    }
    const values = named(args, profile);
    const formatArg = values[0];
    if (!formatArg || formatArg.type !== 'string_literal' || values.some((value) => isSplatNode(value.type))) {
      continue;
    }
    const specs = javaSpecifiers(stringContent(formatArg));
    const rest = values.slice(1);
    if (specs.length !== rest.length) {
      out.push(nodeRange(call));
      continue;
    }
    if (
      specs.some((spec, index) => {
        const value = rest[index];
        if (spec === 'd') {
          return value.type === 'string_literal' || value.type === 'decimal_floating_point_literal';
        }
        return spec === 'f' && value.type === 'string_literal';
      })
    ) {
      out.push(nodeRange(call));
    }
  }
  return out;
}

function javaSpecifiers(pattern: string): string[] {
  const out: string[] = [];
  const regex = /%(?:\d+\$)?[-#+ 0,(<]*\d*(?:\.\d+)?[tT]?([a-zA-Z%])/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pattern)) !== null) {
    if (match[1] !== '%' && match[1] !== 'n') {
      out.push(match[1]);
    }
  }
  return out;
}

function pythonFormatMismatch(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const node of descendantsOf(tree.rootNode, ['binary_operator'])) {
    if (operatorOf(node) !== '%') {
      continue;
    }
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right || left.type !== 'string') {
      continue;
    }
    const count = percentSpecifiers(stringContent(left));
    if (count === undefined) {
      continue;
    }
    const values =
      right.type === 'tuple' ? named(right, profile) : [right];
    if (values.some((value) => isSplatNode(value.type))) {
      continue;
    }
    if (count !== values.length) {
      out.push(nodeRange(node));
    }
  }
  for (const call of descendantsOf(tree.rootNode, ['call'])) {
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'attribute') {
      continue;
    }
    const attribute = fn.childForFieldName('attribute');
    const object = fn.childForFieldName('object');
    if (attribute?.text !== 'format' || object?.type !== 'string') {
      continue;
    }
    const args = call.childForFieldName('arguments');
    const values = args ? named(args, profile) : [];
    if (values.some((value) => value.type === 'keyword_argument' || isSplatNode(value.type))) {
      continue;
    }
    const count = formatFields(stringContent(object));
    if (count !== undefined && count !== values.length) {
      out.push(nodeRange(call));
    }
  }
  return out;
}

function percentSpecifiers(pattern: string): number | undefined {
  if (pattern.includes('%(')) {
    return undefined;
  }
  const regex = /%[-#+ 0]*\d*(?:\.\d+)?[diouxXeEfFgGcrsa%]/g;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pattern)) !== null) {
    if (!match[0].endsWith('%')) {
      count++;
    }
  }
  return count;
}

function formatFields(pattern: string): number | undefined {
  let auto = 0;
  let maxIndex = -1;
  let automatic = false;
  let explicit = false;
  const regex = /\{\{|\}\}|\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pattern)) !== null) {
    if (match[0] === '{{' || match[0] === '}}') {
      continue;
    }
    const name = (match[1] ?? '').split(/[!:]/)[0].trim();
    if (name === '') {
      auto++;
      automatic = true;
      continue;
    }
    if (!/^\d+$/.test(name)) {
      return undefined;
    }
    explicit = true;
    maxIndex = Math.max(maxIndex, Number(name));
  }
  if (automatic && explicit) {
    return undefined;
  }
  return explicit ? maxIndex + 1 : auto;
}

function constantCondition(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  const conditions: Node[] = [];
  for (const node of descendantsOf(tree.rootNode, [profile.ifNode])) {
    const condition = node.childForFieldName('condition');
    if (condition) {
      conditions.push(condition);
    }
  }
  for (const node of descendantsOf(tree.rootNode, profile.loopNodes)) {
    const condition = node.childForFieldName('condition');
    if (condition) {
      conditions.push(condition);
    }
  }
  if (profile.ternaryNode) {
    for (const node of descendantsOf(tree.rootNode, [profile.ternaryNode])) {
      const condition = node.childForFieldName('condition');
      if (condition) {
        conditions.push(condition);
      }
    }
  }
  for (const condition of conditions) {
    if (typeof foldConstant(condition, profile) === 'boolean' && isFoldedComparison(condition, profile)) {
      out.push(nodeRange(condition));
    }
  }
  return out;
}

function foldConstant(
  node: Node,
  profile: LanguageProfile,
): number | string | boolean | undefined {
  if (node.type === 'parenthesized_expression') {
    const inner = named(node, profile)[0];
    return inner ? foldConstant(inner, profile) : undefined;
  }
  if (profile.numberNode.includes(node.type)) {
    const value = Number(node.text.replace(/_/g, ''));
    return Number.isNaN(value) ? undefined : value;
  }
  if (profile.stringNode.includes(node.type)) {
    return descendantsOf(node, ['template_substitution', 'interpolation']).length > 0
      ? undefined
      : node.text;
  }
  if (isTrueLiteral(node, profile)) {
    return true;
  }
  if (isFalseLiteral(node, profile)) {
    return false;
  }
  if (!profile.binaryNode.includes(node.type)) {
    return undefined;
  }
  const operands = named(node, profile);
  if (operands.length !== 2) {
    return undefined;
  }
  const left = foldConstant(operands[0], profile);
  const right = foldConstant(operands[1], profile);
  if (left === undefined || right === undefined) {
    return undefined;
  }
  return foldBinary(left, right, operatorOf(node), profile);
}

function foldBinary(
  left: number | string | boolean,
  right: number | string | boolean,
  operator: string | undefined,
  profile: LanguageProfile,
): number | string | boolean | undefined {
  if (operator === '+' || operator === '-' || operator === '*' || operator === '/' || operator === '%') {
    if (typeof left !== 'number' || typeof right !== 'number') {
      return undefined;
    }
    if ((operator === '/' || operator === '%') && right === 0) {
      return undefined;
    }
    if (operator === '+') {
      return left + right;
    }
    if (operator === '-') {
      return left - right;
    }
    if (operator === '*') {
      return left * right;
    }
    if (operator === '/') {
      return left / right;
    }
    return left % right;
  }
  if (isJsLike(profile) && (typeof left === 'string' || typeof right === 'string')) {
    return undefined;
  }
  if (operator === '==' || operator === '===') {
    return left === right;
  }
  if (operator === '!=' || operator === '!==') {
    return left !== right;
  }
  if (typeof left !== typeof right) {
    return undefined;
  }
  if (operator === '<') {
    return left < right;
  }
  if (operator === '<=') {
    return left <= right;
  }
  if (operator === '>') {
    return left > right;
  }
  if (operator === '>=') {
    return left >= right;
  }
  return undefined;
}

const INT_MIN = -2147483648n;
const INT_MAX = 2147483647n;
const LONG_MIN = -9223372036854775808n;
const LONG_MAX = 9223372036854775807n;

interface IntegerLiteral {
  value: bigint;
  wide: boolean;
}

function integerLiteral(node: Node, profile: LanguageProfile): IntegerLiteral | null {
  if (profile.language === 'java') {
    if (node.type !== 'decimal_integer_literal' && node.type !== 'hex_integer_literal') {
      return null;
    }
    const raw = node.text.replace(/_/g, '');
    const suffixed = /[lL]$/.test(raw);
    const text = raw.replace(/[lL]$/, '');
    if (/^0\d/.test(text)) {
      return null;
    }
    try {
      const value = BigInt(text);
      return { value, wide: suffixed || value > INT_MAX };
    } catch {
      return null;
    }
  }
  if (profile.language === 'go') {
    if (node.type !== 'int_literal') {
      return null;
    }
    try {
      return { value: BigInt(node.text.replace(/_/g, '')), wide: true };
    } catch {
      return null;
    }
  }
  return null;
}

function isMinValueField(node: Node): boolean {
  if (node.type !== 'field_access') {
    return false;
  }
  const object = node.childForFieldName('object');
  const field = node.childForFieldName('field');
  if (!object || !field || field.text !== 'MIN_VALUE') {
    return false;
  }
  return object.text === 'Integer' || object.text === 'Long';
}

function integerOverflowLiteral(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  if (profile.language === 'java') {
    for (const call of descendantsOf(tree.rootNode, ['method_invocation'])) {
      if (call.childForFieldName('name')?.text !== 'abs' || call.childForFieldName('object')?.text !== 'Math') {
        continue;
      }
      const args = call.childForFieldName('arguments');
      const first = args ? named(args, profile)[0] : undefined;
      if (first && isMinValueField(first)) {
        out.push(nodeRange(call));
      }
    }
  }
  if (profile.language === 'java' || profile.language === 'go') {
    for (const binary of descendantsOf(tree.rootNode, ['binary_expression'])) {
      if (operatorOf(binary) !== '*') {
        continue;
      }
      const operands = named(binary, profile);
      if (operands.length !== 2) {
        continue;
      }
      const left = integerLiteral(operands[0], profile);
      const right = integerLiteral(operands[1], profile);
      if (!left || !right) {
        continue;
      }
      const product = left.value * right.value;
      const min = left.wide || right.wide ? LONG_MIN : INT_MIN;
      const max = left.wide || right.wide ? LONG_MAX : INT_MAX;
      if (product < min || product > max) {
        out.push(nodeRange(binary));
      }
    }
  }
  return out;
}

function isFoldedComparison(node: Node, profile: LanguageProfile): boolean {
  if (node.type === 'parenthesized_expression') {
    const inner = named(node, profile)[0];
    return inner ? isFoldedComparison(inner, profile) : false;
  }
  if (!profile.binaryNode.includes(node.type)) {
    return false;
  }
  const operator = operatorOf(node);
  return (
    operator === '==' ||
    operator === '===' ||
    operator === '!=' ||
    operator === '!==' ||
    operator === '<' ||
    operator === '<=' ||
    operator === '>' ||
    operator === '>='
  );
}

export const analyzersPack: RulePack = {
  id: 'analyzers',
  languages: SCAN_LANGUAGES,
  rules: [
    {
      kind: 'analyzer',
      id: 'an-cognitive-complexity',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: cognitiveComplexity,
      message: 'Cognitive complexity is too high.',
      why: 'The function combines many decision points and nesting levels, which makes it hard to follow and test.',
      fix: 'Extract helper functions and simplify the branching until the score is at or below 15.',
    },
    {
      kind: 'analyzer',
      id: 'an-deep-nesting',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: deepNesting,
      message: 'Block nesting is too deep.',
      why: 'Deeply nested blocks are hard to read and usually hide missing early returns.',
      fix: 'Use guard clauses or extract the inner block into a named function.',
    },
    {
      kind: 'analyzer',
      id: 'an-long-function',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: longFunction,
      message: 'Function is longer than 80 lines.',
      why: 'Long functions carry several responsibilities and are hard to review and test.',
      fix: 'Split the function into smaller functions with a single purpose each.',
    },
    {
      kind: 'analyzer',
      id: 'an-too-many-params',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: tooManyParams,
      message: 'Function has too many parameters.',
      why: 'Long parameter lists are hard to call correctly and usually indicate a missing abstraction.',
      fix: 'Group related parameters into an options object or introduce a parameter object.',
    },
    {
      kind: 'analyzer',
      id: 'an-too-many-returns',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: tooManyReturns,
      message: 'Function has too many return statements.',
      why: 'Many exits make the control flow hard to trace and easy to break.',
      fix: 'Consolidate the exits or extract branches into helper functions.',
    },
    {
      kind: 'analyzer',
      id: 'an-unused-local',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: unusedLocal,
      message: 'Local variable is never used.',
      why: 'An unused local adds noise and can indicate a mistake or forgotten logic.',
      fix: 'Remove the variable or use it in the code that follows.',
    },
    {
      kind: 'analyzer',
      id: 'an-unused-param',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: unusedParam,
      message: 'Parameter is never used.',
      why: 'An unused parameter suggests dead API surface or a body that forgot to use it.',
      fix: 'Remove the parameter or prefix it with an underscore when the signature is fixed.',
    },
    {
      kind: 'analyzer',
      id: 'an-duplicated-block',
      category: 'smell',
      severity: 'info',
      languages: SCAN_LANGUAGES,
      run: duplicatedBlock,
      message: 'Duplicated function body.',
      why: 'Two functions with the same normalized statements must be kept in sync by hand.',
      fix: 'Extract the shared statements into one function and call it from both places.',
    },
    {
      kind: 'analyzer',
      id: 'an-format-string-mismatch',
      category: 'bug',
      severity: 'warning',
      languages: SCAN_LANGUAGES,
      run: formatStringMismatch,
      message: 'Format string does not match its arguments.',
      why: 'A placeholder without a matching argument throws at runtime or silently formats the wrong value.',
      fix: 'Make the number of placeholders and arguments match.',
    },
    {
      kind: 'analyzer',
      id: 'an-constant-condition',
      category: 'bug',
      severity: 'warning',
      languages: SCAN_LANGUAGES,
      run: constantCondition,
      message: 'Condition folds to a constant.',
      why: 'A comparison of literals always evaluates to the same value, so one branch can never run.',
      fix: 'Remove the condition or replace it with the value the comparison actually produces.',
    },
    {
      kind: 'analyzer',
      id: 'an-integer-overflow-literal',
      category: 'bug',
      severity: 'warning',
      languages: ['java', 'go'],
      run: integerOverflowLiteral,
      message: 'Integer literal arithmetic overflows.',
      why: 'The product of these literals does not fit the integer type and silently wraps around.',
      fix: 'Use a wider type such as long or a smaller constant.',
    },
  ],
};
