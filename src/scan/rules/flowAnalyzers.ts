import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from '../languages/profiles';
import type { RulePack, ScanRange } from '../ruleTypes';
import { nodeRange } from '../treeSitter';
import {
  SCAN_LANGUAGES,
  bodyOf,
  descendantsOf,
  functionsOf,
  isCatchNode,
  isFunctionType,
  isJsLike,
  named,
  operatorOf,
  parametersOf,
  statementsOf,
} from './analyzerUtils';

const JS_LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];
const FLOW_LANGUAGES = SCAN_LANGUAGES;
const ITERATION_LANGUAGES = [...JS_LANGUAGES, 'python', 'java', 'go'];
const RESOURCE_LANGUAGES = [...JS_LANGUAGES, 'python', 'java', 'go'];
const COUPLING_LANGUAGES = [...JS_LANGUAGES, 'java', 'python', 'php'];

export interface WriteTarget {
  name: string;
  value: Node | null;
  report: Node;
}

export interface LocalWrite {
  name: string;
  value: Node | null;
  node: Node;
  statement: Node;
}

export type StraightLineResult = 'hit' | 'safe' | 'unknown' | 'end';
export type StraightLineOutcome = 'hit' | 'safe' | 'unknown' | 'continue';

export function identifierTypes(profile: LanguageProfile): string[] {
  if (isJsLike(profile)) {
    return ['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'];
  }
  if (profile.language === 'php') {
    return ['variable_name'];
  }
  return ['identifier'];
}

export function withinFunction(node: Node, types: string[], profile: LanguageProfile): Node[] {
  const out: Node[] = [];
  const visit = (current: Node): void => {
    for (const child of named(current, profile)) {
      if (isFunctionType(child.type, profile)) {
        continue;
      }
      if (types.length === 0 || types.includes(child.type)) {
        out.push(child);
      }
      visit(child);
    }
  };
  visit(node);
  return out;
}

export function isStatementList(type: string, profile: LanguageProfile): boolean {
  return profile.blockNode.includes(type) || (profile.statementListNode !== undefined && type === profile.statementListNode);
}

export function statementContaining(
  node: Node,
  profile: LanguageProfile,
): { list: Node; statement: Node } | null {
  let current: Node | null = node;
  while (current && current.parent) {
    const parent: Node = current.parent;
    if (isStatementList(parent.type, profile)) {
      return { list: parent, statement: current };
    }
    current = parent;
  }
  return null;
}

export function isControlFlowType(type: string, profile: LanguageProfile): boolean {
  if (
    type === profile.ifNode ||
    (profile.elseIfNode !== undefined && type === profile.elseIfNode) ||
    profile.loopNodes.includes(type) ||
    type === profile.switchNode ||
    (profile.ternaryNode !== undefined && type === profile.ternaryNode) ||
    isCatchNode(type)
  ) {
    return true;
  }
  return (
    type === 'try_statement' ||
    type === 'try_with_resources_statement' ||
    type === 'with_statement' ||
    type === 'switch_block' ||
    type === 'match_block'
  );
}

export function containsControlFlow(node: Node, profile: LanguageProfile): boolean {
  if (isControlFlowType(node.type, profile)) {
    return true;
  }
  return withinFunction(node, [], profile).some((child) => isControlFlowType(child.type, profile));
}

export function isStraightLine(statement: Node, body: Node, profile: LanguageProfile): boolean {
  let current: Node | null = statement.parent;
  while (current && current.id !== body.id) {
    if (isFunctionType(current.type, profile)) {
      return false;
    }
    if (isControlFlowType(current.type, profile)) {
      return false;
    }
    current = current.parent;
  }
  return current !== null;
}

export function walkStraightLine(
  start: Node,
  body: Node,
  profile: LanguageProfile,
  visit: (statement: Node) => StraightLineOutcome,
): StraightLineResult {
  const origin = statementContaining(start, profile);
  if (!origin) {
    return 'unknown';
  }
  let list = origin.list;
  let statement = origin.statement;
  for (;;) {
    const siblings = statementsOf(list, profile);
    const index = siblings.findIndex((sibling) => sibling.id === statement.id);
    if (index < 0) {
      return 'unknown';
    }
    for (let i = index + 1; i < siblings.length; i++) {
      const outcome = visit(siblings[i]);
      if (outcome !== 'continue') {
        return outcome;
      }
    }
    if (list.id === body.id) {
      return 'end';
    }
    const next = statementContaining(list, profile);
    if (!next || next.statement.id === statement.id) {
      return 'unknown';
    }
    if (isFunctionType(next.statement.type, profile) || isControlFlowType(next.statement.type, profile)) {
      return 'unknown';
    }
    list = next.list;
    statement = next.statement;
  }
}

export function writeContainerTypes(profile: LanguageProfile): string[] {
  if (isJsLike(profile)) {
    return ['lexical_declaration', 'variable_declaration', 'assignment_expression'];
  }
  if (profile.language === 'python') {
    return ['assignment'];
  }
  if (profile.language === 'java') {
    return ['local_variable_declaration', 'assignment_expression'];
  }
  if (profile.language === 'go') {
    return ['short_var_declaration', 'assignment_statement', 'var_declaration'];
  }
  if (profile.language === 'php') {
    return ['assignment_expression'];
  }
  return [];
}

export function writeTargets(node: Node, profile: LanguageProfile): WriteTarget[] {
  const statement =
    node.type === 'expression_statement' ? (named(node, profile)[0] ?? node) : node;
  if (isJsLike(profile)) {
    if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
      return declaratorTargets(statement, profile);
    }
    return assignmentTarget(statement, profile, 'identifier');
  }
  if (profile.language === 'python') {
    if (statement.type !== 'assignment') {
      return [];
    }
    return assignmentTarget(statement, profile, 'identifier');
  }
  if (profile.language === 'java') {
    if (statement.type === 'local_variable_declaration') {
      return declaratorTargets(statement, profile);
    }
    if (statement.type === 'assignment_expression' && operatorOf(statement) === '=') {
      return assignmentTarget(statement, profile, 'identifier');
    }
    return [];
  }
  if (profile.language === 'go') {
    if (statement.type === 'var_declaration') {
      const out: WriteTarget[] = [];
      for (const spec of named(statement, profile)) {
        if (spec.type !== 'var_spec') {
          continue;
        }
        const name = spec.childForFieldName('name');
        const values = spec.childForFieldName('value');
        const value = values ? named(values, profile)[0] ?? null : null;
        if (name && name.type === 'identifier') {
          out.push({ name: name.text, value, report: spec });
        }
      }
      return out;
    }
    if (statement.type === 'short_var_declaration' || statement.type === 'assignment_statement') {
      const operator = statement.childForFieldName('operator');
      if (operator && operator.text !== '=') {
        return [];
      }
      const left = statement.childForFieldName('left');
      const right = statement.childForFieldName('right');
      if (!left || !right) {
        return [];
      }
      const names = named(left, profile).filter((child) => child.type === 'identifier');
      const values = named(right, profile);
      return names.map((name, index) => ({
        name: name.text,
        value: values[index] ?? null,
        report: name,
      }));
    }
    return [];
  }
  if (profile.language === 'php') {
    if (statement.type === 'assignment_expression' && operatorOf(statement) === '=') {
      return assignmentTarget(statement, profile, 'variable_name');
    }
    return [];
  }
  return [];
}

function declaratorTargets(node: Node, profile: LanguageProfile): WriteTarget[] {
  const out: WriteTarget[] = [];
  for (const child of named(node, profile)) {
    if (child.type !== 'variable_declarator') {
      continue;
    }
    const name = child.childForFieldName('name');
    if (name && name.type === 'identifier') {
      out.push({ name: name.text, value: child.childForFieldName('value'), report: child });
    }
  }
  return out;
}

function assignmentTarget(node: Node, profile: LanguageProfile, leftType: string): WriteTarget[] {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || left.type !== leftType || !right) {
    return [];
  }
  return [{ name: left.text, value: right, report: node }];
}

export function writesIn(body: Node, profile: LanguageProfile): LocalWrite[] {
  const out: LocalWrite[] = [];
  for (const node of withinFunction(body, writeContainerTypes(profile), profile)) {
    const located = statementContaining(node, profile);
    if (!located) {
      continue;
    }
    if (located.statement.id !== node.id && located.statement.type !== 'expression_statement') {
      continue;
    }
    for (const target of writeTargets(node, profile)) {
      out.push({ name: target.name, value: target.value, node: target.report, statement: located.statement });
    }
  }
  return out;
}

export function referencesName(node: Node, name: string, profile: LanguageProfile): boolean {
  return descendantsOf(node, identifierTypes(profile)).some((child) => child.text === name);
}

export function parameterNameTexts(fn: Node, profile: LanguageProfile): Set<string> {
  const out = new Set<string>();
  const params = parametersOf(fn);
  if (!params) {
    return out;
  }
  for (const id of descendantsOf(params, identifierTypes(profile))) {
    out.add(id.text);
  }
  return out;
}

export function capturedNames(body: Node, profile: LanguageProfile): Set<string> {
  const out = new Set<string>();
  for (const fn of descendantsOf(body, profile.functionNodes)) {
    for (const id of descendantsOf(fn, identifierTypes(profile))) {
      out.add(id.text);
    }
  }
  return out;
}

function declaredNames(body: Node, profile: LanguageProfile): Set<string> {
  const containers = isJsLike(profile) ? ['lexical_declaration', 'variable_declaration'] : writeContainerTypes(profile);
  const out = new Set<string>();
  for (const node of withinFunction(body, containers, profile)) {
    for (const target of writeTargets(node, profile)) {
      out.add(target.name);
    }
  }
  return out;
}

function deadStore(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (!body || isFunctionType(body.type, profile)) {
      continue;
    }
    const params = parameterNameTexts(fn, profile);
    const captured = capturedNames(body, profile);
    const declared = isJsLike(profile) ? declaredNames(body, profile) : undefined;
    for (const write of writesIn(body, profile)) {
      const { name, value, node, statement } = write;
      if (!value || name.startsWith('_') || params.has(name) || captured.has(name)) {
        continue;
      }
      if (declared && !declared.has(name)) {
        continue;
      }
      if (!isStraightLine(statement, body, profile)) {
        continue;
      }
      const outcome = walkStraightLine(statement, body, profile, (sibling) => {
        const targets = writeTargets(sibling, profile).filter((target) => target.name === name);
        if (targets.length > 0) {
          return targets.some((target) => target.value !== null && referencesName(target.value, name, profile))
            ? 'safe'
            : 'hit';
        }
        if (referencesName(sibling, name, profile)) {
          return 'safe';
        }
        if (sibling.type === profile.returnNode || (profile.throwNode !== undefined && sibling.type === profile.throwNode)) {
          return 'hit';
        }
        if (containsControlFlow(sibling, profile)) {
          return 'unknown';
        }
        return 'continue';
      });
      if (outcome === 'hit' || outcome === 'end') {
        out.push(nodeRange(node));
      }
    }
  }
  return out;
}

function selfCallExpression(statement: Node, profile: LanguageProfile): Node | null {
  if (statement.type === profile.returnNode) {
    const values = named(statement, profile);
    if (values.length === 0) {
      return null;
    }
    const first = values[0];
    if (first.type === 'expression_list') {
      const inner = named(first, profile);
      return inner.length === 1 ? inner[0] : null;
    }
    return first;
  }
  if (statement.type === 'expression_statement') {
    return named(statement, profile)[0] ?? null;
  }
  return null;
}

function isSelfCallee(call: Node, name: string, profile: LanguageProfile): boolean {
  if (isJsLike(profile)) {
    const fn = call.childForFieldName('function');
    if (fn?.type === 'identifier') {
      return fn.text === name;
    }
    if (fn?.type === 'member_expression') {
      return fn.childForFieldName('object')?.text === 'this' && fn.childForFieldName('property')?.text === name;
    }
    return false;
  }
  if (profile.language === 'python') {
    const fn = call.childForFieldName('function');
    if (fn?.type === 'identifier') {
      return fn.text === name;
    }
    if (fn?.type === 'attribute') {
      const object = fn.childForFieldName('object');
      return (
        (object?.text === 'self' || object?.text === 'cls') && fn.childForFieldName('attribute')?.text === name
      );
    }
    return false;
  }
  if (profile.language === 'java') {
    const method = call.childForFieldName('name');
    const object = call.childForFieldName('object');
    if (!method || method.text !== name) {
      return false;
    }
    return !object || object.text === 'this';
  }
  if (profile.language === 'go') {
    const fn = call.childForFieldName('function');
    return fn?.type === 'identifier' && fn.text === name;
  }
  if (profile.language === 'php') {
    if (call.type === 'function_call_expression') {
      return call.childForFieldName('function')?.text === name;
    }
    if (call.type === 'member_call_expression') {
      return (
        call.childForFieldName('object')?.text === '$this' && call.childForFieldName('name')?.text === name
      );
    }
    return false;
  }
  return false;
}

function infiniteRecursion(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    if (profile.constructorNode !== undefined && fn.type === profile.constructorNode) {
      continue;
    }
    const name = fn.childForFieldName('name')?.text;
    if (!name || name === 'constructor' || name === '__construct') {
      continue;
    }
    const body = bodyOf(fn);
    if (!body || !isStatementList(body.type, profile)) {
      continue;
    }
    if (parameterNameTexts(fn, profile).has(name) || declaredNames(body, profile).has(name)) {
      continue;
    }
    if (containsControlFlow(body, profile)) {
      continue;
    }
    const statements = statementsOf(body, profile);
    const last = statements[statements.length - 1];
    if (!last) {
      continue;
    }
    const expression = selfCallExpression(last, profile);
    if (!expression) {
      continue;
    }
    if (profile.callNode.includes(expression.type) && isSelfCallee(expression, name, profile)) {
      out.push(nodeRange(expression));
    }
  }
  return out;
}

interface IndexedLiteral {
  count: number;
}

function constantIndex(node: Node | null, profile: LanguageProfile): number | null {
  if (!node) {
    return null;
  }
  if (isJsLike(profile)) {
    if (node.type === 'unary_expression' && operatorOf(node) === '-') {
      const inner = named(node, profile)[0];
      const value = inner ? constantIndex(inner, profile) : null;
      return value === null ? null : -value;
    }
    return node.type === 'number' && /^\d+$/.test(node.text.replace(/_/g, ''))
      ? Number(node.text.replace(/_/g, ''))
      : null;
  }
  if (profile.language === 'python') {
    if (node.type === 'unary_operator' && operatorOf(node) === '-') {
      const inner = named(node, profile)[0];
      const value = inner ? constantIndex(inner, profile) : null;
      return value === null ? null : -value;
    }
    return node.type === 'integer' && /^\d+$/.test(node.text.replace(/_/g, ''))
      ? Number(node.text.replace(/_/g, ''))
      : null;
  }
  if (profile.language === 'java') {
    if (node.type === 'unary_expression' && operatorOf(node) === '-') {
      const inner = named(node, profile)[0];
      const value = inner ? constantIndex(inner, profile) : null;
      return value === null ? null : -value;
    }
    if (node.type === 'decimal_integer_literal' || node.type === 'hex_integer_literal') {
      const text = node.text.replace(/_/g, '').replace(/[lL]$/, '');
      if (/^0\d/.test(text)) {
        return null;
      }
      const value = Number(text);
      return Number.isSafeInteger(value) ? value : null;
    }
    return null;
  }
  if (profile.language === 'go') {
    if (node.type === 'unary_expression' && operatorOf(node) === '-') {
      const inner = named(node, profile)[0];
      const value = inner ? constantIndex(inner, profile) : null;
      return value === null ? null : -value;
    }
    if (node.type === 'int_literal') {
      const value = Number(node.text.replace(/_/g, ''));
      return Number.isSafeInteger(value) ? value : null;
    }
    return null;
  }
  if (profile.language === 'php') {
    return node.type === 'integer' && /^\d+$/.test(node.text.replace(/_/g, ''))
      ? Number(node.text.replace(/_/g, ''))
      : null;
  }
  return null;
}

function jsLiteralCount(node: Node): IndexedLiteral | null {
  if (node.type === 'parenthesized_expression') {
    const inner = node.namedChildren.find((child) => child !== null);
    if (inner && inner.type === 'sequence_expression') {
      return { count: inner.namedChildren.filter((child) => child !== null).length };
    }
    return null;
  }
  if (node.type !== 'array') {
    return null;
  }
  const elements = node.namedChildren.filter((child) => child !== null);
  if (elements.some((element) => element.type === 'spread_element')) {
    return null;
  }
  const commas = node.children.filter((child) => child !== null && child.type === ',').length;
  if (commas + 1 !== elements.length) {
    return null;
  }
  return { count: elements.length };
}

function pythonLiteralCount(node: Node, profile: LanguageProfile): IndexedLiteral | null {
  if (node.type !== 'list' && node.type !== 'tuple') {
    return null;
  }
  const elements = named(node, profile);
  if (elements.some((element) => element.type.includes('splat'))) {
    return null;
  }
  return { count: elements.length };
}

function literalIndexOutOfBounds(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  if (isJsLike(profile)) {
    for (const subscript of descendantsOf(tree.rootNode, ['subscript_expression'])) {
      const object = subscript.childForFieldName('object');
      const index = subscript.childForFieldName('index');
      const literal = object ? jsLiteralCount(object) : null;
      const value = constantIndex(index, profile);
      if (!literal || value === null) {
        continue;
      }
      if (value < 0 || value >= literal.count) {
        out.push(nodeRange(subscript));
      }
    }
    return out;
  }
  if (profile.language === 'python') {
    for (const subscript of descendantsOf(tree.rootNode, ['subscript'])) {
      const object = subscript.childForFieldName('value');
      const index = subscript.childForFieldName('subscript');
      const literal = object ? pythonLiteralCount(object, profile) : null;
      const value = constantIndex(index, profile);
      if (!literal || value === null) {
        continue;
      }
      const effective = value < 0 ? literal.count + value : value;
      if (effective < 0 || effective >= literal.count) {
        out.push(nodeRange(subscript));
      }
    }
    return out;
  }
  if (profile.language === 'java') {
    for (const access of descendantsOf(tree.rootNode, ['array_access'])) {
      const array = access.childForFieldName('array');
      const index = access.childForFieldName('index');
      if (!array || array.type !== 'array_creation_expression') {
        continue;
      }
      const initializer = array.childForFieldName('value');
      if (!initializer || initializer.type !== 'array_initializer') {
        continue;
      }
      const count = named(initializer, profile).length;
      const value = constantIndex(index, profile);
      if (value === null) {
        continue;
      }
      if (value < 0 || value >= count) {
        out.push(nodeRange(access));
      }
    }
    return out;
  }
  if (profile.language === 'go') {
    for (const access of descendantsOf(tree.rootNode, ['index_expression'])) {
      const operand = access.childForFieldName('operand');
      const index = access.childForFieldName('index');
      if (!operand || operand.type !== 'composite_literal') {
        continue;
      }
      const body = operand.childForFieldName('body');
      if (!body || body.type !== 'literal_value') {
        continue;
      }
      const count = named(body, profile).length;
      const value = constantIndex(index, profile);
      if (value === null) {
        continue;
      }
      if (value < 0 || value >= count) {
        out.push(nodeRange(access));
      }
    }
    return out;
  }
  if (profile.language === 'php') {
    for (const subscript of descendantsOf(tree.rootNode, ['subscript_expression'])) {
      const children = named(subscript, profile);
      const object = children[0];
      const index = children[1];
      if (!object || !index || object.type !== 'array_creation_expression') {
        continue;
      }
      const elements = named(object, profile);
      if (elements.some((element) => element.type !== 'array_element_initializer')) {
        continue;
      }
      if (elements.some((element) => element.childForFieldName('key') !== null)) {
        continue;
      }
      const value = constantIndex(index, profile);
      if (value === null) {
        continue;
      }
      if (value < 0 || value >= elements.length) {
        out.push(nodeRange(subscript));
      }
    }
    return out;
  }
  return out;
}

const JS_MUTATORS = new Set(['splice', 'push', 'pop', 'shift', 'unshift', 'sort', 'reverse']);
const PYTHON_MUTATORS = new Set(['remove', 'pop', 'append', 'clear', 'sort', 'insert']);
const JAVA_MUTATORS = new Set(['remove', 'add', 'clear']);

function collectionModifiedDuringIteration(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  if (isJsLike(profile)) {
    for (const loop of descendantsOf(tree.rootNode, ['for_in_statement'])) {
      const collection = loop.childForFieldName('right');
      const body = loop.childForFieldName('body');
      if (!collection || collection.type !== 'identifier' || !body) {
        continue;
      }
      for (const call of descendantsOf(body, ['call_expression'])) {
        const fn = call.childForFieldName('function');
        if (!fn || fn.type !== 'member_expression') {
          continue;
        }
        const object = fn.childForFieldName('object');
        const property = fn.childForFieldName('property');
        if (object?.type === 'identifier' && object.text === collection.text && property && JS_MUTATORS.has(property.text)) {
          out.push(nodeRange(call));
        }
      }
    }
    return out;
  }
  if (profile.language === 'python') {
    for (const loop of descendantsOf(tree.rootNode, ['for_statement'])) {
      const collection = loop.childForFieldName('right');
      const body = loop.childForFieldName('body');
      if (!collection || collection.type !== 'identifier' || !body) {
        continue;
      }
      for (const call of descendantsOf(body, ['call'])) {
        const fn = call.childForFieldName('function');
        if (!fn || fn.type !== 'attribute') {
          continue;
        }
        const object = fn.childForFieldName('object');
        const attribute = fn.childForFieldName('attribute');
        if (
          object?.type === 'identifier' &&
          object.text === collection.text &&
          attribute &&
          PYTHON_MUTATORS.has(attribute.text)
        ) {
          out.push(nodeRange(call));
        }
      }
    }
    return out;
  }
  if (profile.language === 'java') {
    for (const loop of descendantsOf(tree.rootNode, ['enhanced_for_statement'])) {
      const collection = loop.childForFieldName('value');
      const body = loop.childForFieldName('body');
      if (!collection || collection.type !== 'identifier' || !body) {
        continue;
      }
      for (const call of descendantsOf(body, ['method_invocation'])) {
        const object = call.childForFieldName('object');
        const method = call.childForFieldName('name');
        if (object?.type === 'identifier' && object.text === collection.text && method && JAVA_MUTATORS.has(method.text)) {
          out.push(nodeRange(call));
        }
      }
    }
    return out;
  }
  if (profile.language === 'go') {
    for (const loop of descendantsOf(tree.rootNode, ['for_statement'])) {
      const body = loop.childForFieldName('body');
      const clause = named(loop, profile).find((child) => child.type === 'range_clause');
      if (!clause || !body) {
        continue;
      }
      const collection = clause.childForFieldName('right');
      if (!collection || collection.type !== 'identifier') {
        continue;
      }
      for (const call of descendantsOf(body, ['call_expression'])) {
        const fn = call.childForFieldName('function');
        if (fn?.type !== 'identifier' || fn.text !== 'delete') {
          continue;
        }
        const args = call.childForFieldName('arguments');
        const first = args ? named(args, profile)[0] : undefined;
        if (first?.type === 'identifier' && first.text === collection.text) {
          out.push(nodeRange(call));
        }
      }
    }
    return out;
  }
  return out;
}

const JAVA_RESOURCES = new Set([
  'FileInputStream',
  'FileOutputStream',
  'FileReader',
  'FileWriter',
  'BufferedReader',
  'BufferedWriter',
  'Connection',
  'Statement',
  'PreparedStatement',
  'Socket',
  'ServerSocket',
  'InputStream',
  'OutputStream',
]);
const GO_OPENERS = new Set(['Open', 'OpenFile', 'Create']);
const JS_OPENERS = new Set(['openSync', 'open', 'createReadStream', 'createWriteStream']);

function containsNode(container: Node, node: Node): boolean {
  return container.startIndex <= node.startIndex && node.endIndex <= container.endIndex;
}

function acquisitionTarget(node: Node, profile: LanguageProfile): string | null {
  let current: Node = node;
  while (
    current.parent &&
    (current.parent.type === 'expression_list' || current.parent.type === 'parenthesized_expression')
  ) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) {
    return null;
  }
  if (parent.type === 'variable_declarator' || parent.type === 'var_spec') {
    const value = parent.childForFieldName('value');
    if (!value || !containsNode(value, current)) {
      return null;
    }
    const name = parent.childForFieldName('name');
    return name?.type === 'identifier' ? name.text : null;
  }
  if (parent.type === 'assignment_expression') {
    const right = parent.childForFieldName('right');
    if (!right || !containsNode(right, current)) {
      return null;
    }
    const left = parent.childForFieldName('left');
    if (left?.type === 'identifier' || left?.type === 'variable_name') {
      return left.text;
    }
    return null;
  }
  if (parent.type === 'assignment_statement' || parent.type === 'short_var_declaration') {
    const right = parent.childForFieldName('right');
    if (!right || !containsNode(right, current)) {
      return null;
    }
    const left = parent.childForFieldName('left');
    const first = left ? named(left, profile)[0] : null;
    return first?.type === 'identifier' ? first.text : null;
  }
  return null;
}

function hasAncestorType(node: Node, types: string[]): boolean {
  let current = node.parent;
  while (current) {
    if (types.includes(current.type)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function hasMethodCall(node: Node, name: string, methods: string[], profile: LanguageProfile): boolean {
  if (isJsLike(profile)) {
    return descendantsOf(node, ['call_expression']).some((call) => {
      const fn = call.childForFieldName('function');
      if (!fn || fn.type !== 'member_expression') {
        return false;
      }
      const object = fn.childForFieldName('object');
      const property = fn.childForFieldName('property');
      return object?.type === 'identifier' && object.text === name && property !== null && methods.includes(property.text);
    });
  }
  if (profile.language === 'python') {
    return descendantsOf(node, ['call']).some((call) => {
      const fn = call.childForFieldName('function');
      if (!fn || fn.type !== 'attribute') {
        return false;
      }
      const object = fn.childForFieldName('object');
      const attribute = fn.childForFieldName('attribute');
      return object?.type === 'identifier' && object.text === name && attribute !== null && methods.includes(attribute.text);
    });
  }
  if (profile.language === 'java') {
    return descendantsOf(node, ['method_invocation']).some((call) => {
      const object = call.childForFieldName('object');
      const method = call.childForFieldName('name');
      return object?.type === 'identifier' && object.text === name && method !== null && methods.includes(method.text);
    });
  }
  if (profile.language === 'go') {
    return descendantsOf(node, ['selector_expression']).some((selector) => {
      const operand = selector.childForFieldName('operand');
      const field = selector.childForFieldName('field');
      return operand?.type === 'identifier' && operand.text === name && field !== null && methods.includes(field.text);
    });
  }
  return false;
}

function resourceLeak(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (!body) {
      continue;
    }
    if (profile.language === 'java') {
      for (const creation of withinFunction(body, ['object_creation_expression'], profile)) {
        const type = creation.childForFieldName('type');
        if (!type || !JAVA_RESOURCES.has(type.text.split('.').pop() ?? '')) {
          continue;
        }
        if (hasAncestorType(creation, ['resource_specification', 'try_with_resources_statement'])) {
          continue;
        }
        const variable = acquisitionTarget(creation, profile);
        if (!variable || hasMethodCall(body, variable, ['close'], profile)) {
          continue;
        }
        out.push(nodeRange(creation));
      }
    } else if (profile.language === 'python') {
      for (const call of withinFunction(body, ['call'], profile)) {
        const fnNode = call.childForFieldName('function');
        const isOpen = fnNode?.type === 'identifier' && fnNode.text === 'open';
        const isSocket =
          fnNode?.type === 'attribute' &&
          fnNode.childForFieldName('object')?.text === 'socket' &&
          fnNode.childForFieldName('attribute')?.text === 'socket';
        if (!isOpen && !isSocket) {
          continue;
        }
        if (hasAncestorType(call, ['with_statement'])) {
          continue;
        }
        const variable = acquisitionTarget(call, profile);
        if (!variable || hasMethodCall(body, variable, ['close'], profile)) {
          continue;
        }
        out.push(nodeRange(call));
      }
    } else if (profile.language === 'go') {
      for (const call of withinFunction(body, ['call_expression'], profile)) {
        const fnNode = call.childForFieldName('function');
        if (!fnNode || fnNode.type !== 'selector_expression') {
          continue;
        }
        const operand = fnNode.childForFieldName('operand');
        const field = fnNode.childForFieldName('field');
        const isOpen = operand?.text === 'os' && field !== null && GO_OPENERS.has(field.text);
        const isDial = operand?.text === 'net' && field?.text === 'Dial';
        if (!isOpen && !isDial) {
          continue;
        }
        const variable = acquisitionTarget(call, profile);
        if (!variable || hasMethodCall(body, variable, ['Close'], profile)) {
          continue;
        }
        out.push(nodeRange(call));
      }
    } else if (isJsLike(profile)) {
      for (const call of withinFunction(body, ['call_expression'], profile)) {
        const fnNode = call.childForFieldName('function');
        if (!fnNode || fnNode.type !== 'member_expression') {
          continue;
        }
        const object = fnNode.childForFieldName('object');
        const property = fnNode.childForFieldName('property');
        if (object?.type !== 'identifier' || object.text !== 'fs' || !property || !JS_OPENERS.has(property.text)) {
          continue;
        }
        const variable = acquisitionTarget(call, profile);
        if (!variable || hasMethodCall(body, variable, ['close', 'destroy'], profile)) {
          continue;
        }
        out.push(nodeRange(call));
      }
    }
  }
  return out;
}

const COUPLING_LIMIT = 20;
const DECLARATION_NODE_TYPES = [
  'function_declaration',
  'function_definition',
  'method_declaration',
  'method_definition',
  'class_declaration',
  'class_definition',
  'constructor_declaration',
  'variable_declarator',
  'property_element',
  'public_field_definition',
  'field_definition',
  'lexical_declaration',
  'variable_declaration',
  'property_declaration',
];

function declaredMemberNames(body: Node, profile: LanguageProfile): Set<string> {
  const out = new Set<string>();
  for (const node of descendantsOf(body, DECLARATION_NODE_TYPES)) {
    const name = node.childForFieldName('name');
    if (name) {
      out.add(name.text);
    }
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const declarator of named(node, profile)) {
        const declared = declarator.childForFieldName('name');
        if (declared) {
          out.add(declared.text);
        }
      }
    }
  }
  return out;
}

function classCoupling(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  if (!COUPLING_LANGUAGES.includes(profile.language)) {
    return out;
  }
  const idTypes =
    profile.language === 'php'
      ? ['name']
      : profile.language === 'java'
        ? ['identifier', 'type_identifier']
        : ['identifier'];
  for (const classNode of descendantsOf(tree.rootNode, profile.classNode)) {
    const body = classNode.childForFieldName('body');
    if (!body) {
      continue;
    }
    const own = classNode.childForFieldName('name')?.text;
    const declared = declaredMemberNames(body, profile);
    const names = new Set<string>();
    for (const id of descendantsOf(body, idTypes)) {
      if (id.text === own || declared.has(id.text) || !/^[A-Z]/.test(id.text)) {
        continue;
      }
      names.add(id.text);
    }
    if (names.size > COUPLING_LIMIT) {
      out.push(nodeRange(classNode));
    }
  }
  return out;
}

export const flowAnalyzersPack: RulePack = {
  id: 'flow-analyzers',
  languages: FLOW_LANGUAGES,
  rules: [
    {
      kind: 'analyzer',
      id: 'an-dead-store',
      category: 'bug',
      severity: 'warning',
      languages: FLOW_LANGUAGES,
      run: deadStore,
      message: 'Assignment is overwritten before it is read.',
      why: 'The value assigned here is never used, so the statement has no effect and usually signals a mistake.',
      fix: 'Remove the assignment or use the variable before assigning it again.',
    },
    {
      kind: 'analyzer',
      id: 'an-infinite-recursion',
      category: 'bug',
      severity: 'warning',
      languages: FLOW_LANGUAGES,
      run: infiniteRecursion,
      message: 'Function calls itself unconditionally.',
      why: 'A self-call on every path recurses until the stack overflows.',
      fix: 'Add a base case or a condition that stops the recursion.',
    },
    {
      kind: 'analyzer',
      id: 'an-literal-index-out-of-bounds',
      category: 'bug',
      severity: 'warning',
      languages: FLOW_LANGUAGES,
      run: literalIndexOutOfBounds,
      message: 'Constant index is out of bounds for this literal.',
      why: 'Indexing a literal with a constant index beyond its length always reads a missing element or throws.',
      fix: 'Use an index inside the literal length or add the missing elements.',
    },
    {
      kind: 'analyzer',
      id: 'an-collection-modified-during-iteration',
      category: 'bug',
      severity: 'warning',
      languages: ITERATION_LANGUAGES,
      run: collectionModifiedDuringIteration,
      message: 'Collection is modified while it is being iterated.',
      why: 'Mutating the iterated collection can skip elements, loop forever, or throw a concurrent modification error.',
      fix: 'Iterate over a copy or collect the changes and apply them after the loop.',
    },
    {
      kind: 'analyzer',
      id: 'an-resource-leak',
      category: 'bug',
      severity: 'warning',
      languages: RESOURCE_LANGUAGES,
      run: resourceLeak,
      message: 'Resource is acquired but never released.',
      why: 'A file, socket, or stream that is never closed leaks a handle until the process exits.',
      fix: 'Close the resource in a finally block, use try-with-resources, defer Close(), or a with statement.',
    },
    {
      kind: 'analyzer',
      id: 'an-class-coupling',
      category: 'smell',
      severity: 'info',
      languages: COUPLING_LANGUAGES,
      run: classCoupling,
      message: 'Class references too many distinct types.',
      why: 'A class that touches many other types is tightly coupled and hard to change or test in isolation.',
      fix: 'Move some responsibilities into collaborators or introduce an interface boundary.',
    },
  ],
};
