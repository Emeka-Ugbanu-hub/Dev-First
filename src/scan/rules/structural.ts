import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from '../languages/profiles';
import type { RulePack, ScanRange } from '../ruleTypes';
import { nodeRange } from '../treeSitter';

const LANGUAGES = [
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'python',
  'java',
  'go',
  'php',
];

function named(node: Node, profile: LanguageProfile): Node[] {
  const out: Node[] = [];
  for (const child of node.namedChildren) {
    if (child && !profile.commentNode.includes(child.type)) {
      out.push(child);
    }
  }
  return out;
}

function descendantsOf(node: Node, types: string[]): Node[] {
  return node.descendantsOfType(types).filter((child): child is Node => child !== null);
}

function normalizedText(node: Node, profile: LanguageProfile): string {
  let text = node.text;
  const comments = descendantsOf(node, profile.commentNode).sort(
    (a, b) => b.startIndex - a.startIndex,
  );
  for (const comment of comments) {
    text = text.slice(0, comment.startIndex - node.startIndex) + text.slice(comment.endIndex - node.startIndex);
  }
  return text.replace(/\s+/g, '');
}

function statementsOf(block: Node, profile: LanguageProfile): Node[] {
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

function ifBody(ifNode: Node, profile: LanguageProfile): Node | null {
  return ifNode.childForFieldName('consequence') ?? ifNode.childForFieldName('body');
}

function elseBlock(ifNode: Node, profile: LanguageProfile): Node | undefined {
  const alternative = ifNode.childForFieldName(profile.elseField);
  if (!alternative) {
    return undefined;
  }
  if (alternative.type === 'else_clause') {
    return named(alternative, profile).find((child) => profile.blockNode.includes(child.type));
  }
  return profile.blockNode.includes(alternative.type) ? alternative : undefined;
}

function isTrueLiteral(node: Node | null, profile: LanguageProfile): boolean {
  if (!node) {
    return false;
  }
  if (node.type === 'parenthesized_expression') {
    return isTrueLiteral(named(node, profile)[0] ?? null, profile);
  }
  return profile.trueLiteral.includes(node.type) || (node.type === 'boolean' && node.text === 'true');
}

function isFalseLiteral(node: Node | null, profile: LanguageProfile): boolean {
  if (!node) {
    return false;
  }
  if (node.type === 'parenthesized_expression') {
    return isFalseLiteral(named(node, profile)[0] ?? null, profile);
  }
  return (
    profile.falseLiteral.includes(node.type) || (node.type === 'boolean' && node.text === 'false')
  );
}

function operatorOf(node: Node): string | undefined {
  for (const child of node.children) {
    if (child && !child.isNamed) {
      return child.type;
    }
  }
  return undefined;
}

function literalValue(node: Node | null, profile: LanguageProfile): number | string | undefined {
  if (!node) {
    return undefined;
  }
  if (profile.numberNode.includes(node.type)) {
    const value = Number(node.text);
    return Number.isNaN(value) ? undefined : value;
  }
  if (profile.stringNode.includes(node.type)) {
    return node.text;
  }
  return undefined;
}

function constantTruth(node: Node | null, profile: LanguageProfile): boolean | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === 'parenthesized_expression') {
    return constantTruth(named(node, profile)[0] ?? null, profile);
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
  const operator = operatorOf(node);
  const operands = named(node, profile);
  if (operator === '&&' || operator === 'and') {
    const values = operands.map((operand) => constantTruth(operand, profile));
    if (values.includes(false)) {
      return false;
    }
    return values.length > 0 && values.every((value) => value === true) ? true : undefined;
  }
  if (operator === '||' || operator === 'or') {
    const values = operands.map((operand) => constantTruth(operand, profile));
    if (values.includes(true)) {
      return true;
    }
    return values.length > 0 && values.every((value) => value === false) ? false : undefined;
  }
  if (operands.length !== 2) {
    return undefined;
  }
  return compareLiterals(operands[0], operands[1], operator, profile);
}

function compareLiterals(
  left: Node,
  right: Node,
  operator: string | undefined,
  profile: LanguageProfile,
): boolean | undefined {
  const a = literalValue(left, profile);
  const b = literalValue(right, profile);
  if (a === undefined || b === undefined || typeof a !== typeof b) {
    return undefined;
  }
  if (operator === '==' || operator === '===') {
    return a === b;
  }
  if (operator === '!=' || operator === '!==') {
    return a !== b;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return compareOrdered(a, b, operator);
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return compareOrdered(a, b, operator);
  }
  return undefined;
}

function compareOrdered(a: number | string, b: number | string, operator: string | undefined): boolean | undefined {
  switch (operator) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    default:
      return undefined;
  }
}

function insideLoop(node: Node, profile: LanguageProfile): boolean {
  let current = node.parent;
  while (current) {
    if (profile.loopNodes.includes(current.type)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function exitsLoop(node: Node, profile: LanguageProfile): boolean {
  const terminators = [profile.breakNode, profile.returnNode, profile.throwNode].filter(
    (type): type is string => Boolean(type),
  );
  const visit = (current: Node, root: boolean): boolean => {
    for (const child of named(current, profile)) {
      if (!root && profile.loopNodes.includes(child.type)) {
        continue;
      }
      if (terminators.includes(child.type)) {
        return true;
      }
      if (visit(child, false)) {
        return true;
      }
    }
    return false;
  };
  return visit(node, true);
}

function isInfiniteLoop(node: Node, profile: LanguageProfile): boolean {
  if (profile.language === 'javascript' || profile.language === 'typescript') {
    if (node.type === 'while_statement' || node.type === 'do_statement') {
      return isTrueLiteral(node.childForFieldName('condition'), profile);
    }
    if (node.type === 'for_statement') {
      const condition = node.childForFieldName('condition');
      return !condition || condition.type === 'empty_statement';
    }
    return false;
  }
  if (profile.language === 'python') {
    return node.type === 'while_statement' && isTrueLiteral(node.childForFieldName('condition'), profile);
  }
  if (profile.language === 'java' || profile.language === 'php') {
    if (node.type === 'while_statement' || node.type === 'do_statement') {
      return isTrueLiteral(node.childForFieldName('condition'), profile);
    }
    return node.type === 'for_statement' && !node.childForFieldName('condition');
  }
  if (profile.language === 'go') {
    return node.type === 'for_statement' && named(node, profile).every((child) => child.type === 'block');
  }
  return false;
}

interface SwitchCase {
  node: Node;
  statements: Node[];
}

function switchCaseNodes(switchNode: Node, profile: LanguageProfile): Node[] {
  const body =
    switchNode.childForFieldName('body') ??
    named(switchNode, profile).find((child) => child.type === 'switch_body');
  const container = body ?? switchNode;
  const caseTypes = [profile.caseNode, profile.defaultCaseNode].filter(
    (type): type is string => Boolean(type),
  );
  return named(container, profile).filter((child) => caseTypes.includes(child.type));
}

function switchCases(switchNode: Node, profile: LanguageProfile): SwitchCase[] {
  const cases: SwitchCase[] = [];
  for (const caseNode of switchCaseNodes(switchNode, profile)) {
    const label = caseLabelNode(caseNode, profile);
    const statements = named(caseNode, profile).filter((child) => {
      if (profile.language === 'java') {
        return child.type !== 'switch_label';
      }
      return !label || child.id !== label.id;
    });
    cases.push({ node: caseNode, statements });
  }
  return cases;
}

function caseLabelNode(caseNode: Node, profile: LanguageProfile): Node | null {
  if (profile.language === 'java') {
    return named(caseNode, profile).find((child) => child.type === 'switch_label') ?? null;
  }
  if (profile.language === 'python') {
    return named(caseNode, profile)[0] ?? null;
  }
  return caseNode.childForFieldName('value');
}

function caseLabelText(caseNode: Node, profile: LanguageProfile): string | undefined {
  const label = caseLabelNode(caseNode, profile);
  if (!label) {
    return undefined;
  }
  const value = profile.language === 'java' ? named(label, profile)[0] : label;
  if (!value) {
    return undefined;
  }
  const text = normalizedText(value, profile);
  if (!text || text === '_' || text === 'default') {
    return undefined;
  }
  return text;
}

function switchFallthrough(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const terminators = [
    profile.breakNode,
    profile.returnNode,
    profile.throwNode,
    profile.continueNode,
  ];
  const out: ScanRange[] = [];
  for (const switchNode of descendantsOf(tree.rootNode, [profile.switchNode])) {
    const cases = switchCases(switchNode, profile);
    for (let i = 0; i < cases.length - 1; i++) {
      const statements = cases[i].statements;
      if (statements.length === 0) {
        continue;
      }
      const last = statements[statements.length - 1];
      if (!terminators.includes(last.type)) {
        out.push(nodeRange(cases[i].node));
      }
    }
  }
  return out;
}

function duplicateCase(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const switchNode of descendantsOf(tree.rootNode, [profile.switchNode])) {
    const seen = new Set<string>();
    for (const caseNode of switchCaseNodes(switchNode, profile)) {
      const label = caseLabelText(caseNode, profile);
      if (!label) {
        continue;
      }
      if (seen.has(label)) {
        out.push(nodeRange(caseNode));
      } else {
        seen.add(label);
      }
    }
  }
  return out;
}

function isHoistable(statement: Node, profile: LanguageProfile): boolean {
  if (profile.language !== 'javascript' && profile.language !== 'typescript') {
    return false;
  }
  return profile.declarationNodes.includes(statement.type);
}

function unreachableCode(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const terminators = [profile.returnNode, profile.throwNode, profile.breakNode, profile.continueNode].filter(
    (type): type is string => Boolean(type),
  );
  const blocks = descendantsOf(tree.rootNode, profile.blockNode);
  if (profile.statementListNode) {
    blocks.push(...descendantsOf(tree.rootNode, [profile.statementListNode]));
  }
  const out: ScanRange[] = [];
  for (const block of blocks) {
    let terminated = false;
    for (const statement of statementsOf(block, profile)) {
      if (terminated) {
        if (!isHoistable(statement, profile)) {
          out.push(nodeRange(statement));
        }
        continue;
      }
      if (terminators.includes(statement.type)) {
        terminated = true;
      }
    }
  }
  return out;
}

function infiniteLoop(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const loop of descendantsOf(tree.rootNode, profile.loopNodes)) {
    if (!isInfiniteLoop(loop, profile)) {
      continue;
    }
    const body = loop.childForFieldName('body');
    if (body && exitsLoop(body, profile)) {
      continue;
    }
    out.push(nodeRange(loop));
  }
  return out;
}

function collapsibleIf(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const ifNode of descendantsOf(tree.rootNode, [profile.ifNode])) {
    if (ifNode.childForFieldName(profile.elseField)) {
      continue;
    }
    const body = ifBody(ifNode, profile);
    if (!body) {
      continue;
    }
    const statements = statementsOf(body, profile);
    if (statements.length === 1 && statements[0].type === profile.ifNode) {
      out.push(nodeRange(statements[0]));
    }
  }
  return out;
}

function stringConcatInLoop(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  const concatOperators = profile.language === 'php' ? ['.=', '+='] : ['+='];
  for (const node of descendantsOf(tree.rootNode, profile.augmentedAssignmentNode)) {
    const operator = operatorOf(node);
    if (!operator || !concatOperators.includes(operator)) {
      continue;
    }
    const right = node.childForFieldName('right');
    if (!right) {
      continue;
    }
    const hasString =
      profile.stringNode.includes(right.type) ||
      descendantsOf(right, profile.stringNode).length > 0;
    if (!hasString) {
      continue;
    }
    const left = node.childForFieldName('left');
    if (!left || descendantsOf(left, profile.identifierNode).length === 0) {
      continue;
    }
    if (insideLoop(node, profile)) {
      out.push(nodeRange(node));
    }
  }
  return out;
}

function isConstructor(member: Node, profile: LanguageProfile): boolean {
  if (profile.constructorNode) {
    return member.type === profile.constructorNode;
  }
  if (profile.constructorName) {
    return member.childForFieldName('name')?.text === profile.constructorName;
  }
  return false;
}

function isPrivateMember(member: Node, profile: LanguageProfile): boolean {
  if (!profile.modifierNode) {
    return false;
  }
  const modifier = member.children.find((child) => child?.type === profile.modifierNode);
  return modifier ? /private|protected/.test(modifier.text) : false;
}

function isStaticMember(member: Node, profile: LanguageProfile): boolean {
  if (profile.language === 'java') {
    if (!profile.modifierNode) {
      return false;
    }
    const modifier = member.children.find((child) => child?.type === profile.modifierNode);
    return modifier ? modifier.text.includes('static') : false;
  }
  return member.children.some((child) => child?.type === 'static');
}

function utilityClassConstructor(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const classNode of descendantsOf(tree.rootNode, profile.classNode)) {
    const body = profile.classBodyNode
      ? named(classNode, profile).find((child) => child.type === profile.classBodyNode)
      : undefined;
    if (!body) {
      continue;
    }
    const members = named(body, profile);
    const constructor = members.find((member) => isConstructor(member, profile));
    if (!constructor || isPrivateMember(constructor, profile)) {
      continue;
    }
    const others = members.filter((member) => member.id !== constructor.id);
    if (others.length > 0 && others.every((member) => isStaticMember(member, profile))) {
      out.push(nodeRange(constructor));
    }
  }
  return out;
}

function identicalIfElse(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const ifNode of descendantsOf(tree.rootNode, [profile.ifNode])) {
    const body = ifBody(ifNode, profile);
    const alternative = elseBlock(ifNode, profile);
    if (!body || !alternative) {
      continue;
    }
    if (normalizedText(body, profile) === normalizedText(alternative, profile)) {
      out.push(nodeRange(ifNode));
    }
  }
  return out;
}

function conditionChain(ifNode: Node, profile: LanguageProfile): Node[] {
  const chain: Node[] = [ifNode];
  if (profile.elseIfNode) {
    for (const alternative of ifNode.childrenForFieldName(profile.elseField)) {
      if (alternative && alternative.type === profile.elseIfNode) {
        chain.push(alternative);
      } else {
        break;
      }
    }
    return chain;
  }
  let current = ifNode;
  while (true) {
    const alternative = current.childForFieldName(profile.elseField);
    if (!alternative) {
      break;
    }
    const next = alternative.type === 'else_clause' ? named(alternative, profile)[0] : alternative;
    if (next && next.type === profile.ifNode) {
      chain.push(next);
      current = next;
    } else {
      break;
    }
  }
  return chain;
}

function duplicatedCondition(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const ifNode of descendantsOf(tree.rootNode, [profile.ifNode])) {
    const seen = new Set<string>();
    for (const branch of conditionChain(ifNode, profile)) {
      const condition = branch.childForFieldName('condition');
      if (!condition) {
        continue;
      }
      const key = normalizedText(condition, profile);
      if (seen.has(key)) {
        out.push(nodeRange(condition));
      } else {
        seen.add(key);
      }
    }
  }
  if (!profile.ternaryNode) {
    return out;
  }
  for (const ternary of descendantsOf(tree.rootNode, [profile.ternaryNode])) {
    const seen = new Set<string>();
    let current: Node | undefined = ternary;
    while (current) {
      const operands = named(current, profile);
      const condition: Node | null =
        current.childForFieldName('condition') ??
        (profile.language === 'python' ? operands[1] : undefined) ??
        null;
      const alternative: Node | null =
        current.childForFieldName('alternative') ??
        (profile.language === 'python' ? operands[2] : undefined) ??
        null;
      if (condition) {
        const key = normalizedText(condition, profile);
        if (seen.has(key)) {
          out.push(nodeRange(condition));
        } else {
          seen.add(key);
        }
      }
      let next: Node | null = alternative;
      if (next && next.type === 'parenthesized_expression') {
        next = named(next, profile)[0] ?? null;
      }
      current = next && next.type === profile.ternaryNode ? next : undefined;
    }
  }
  return out;
}

function unreachableBranch(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const ifNode of descendantsOf(tree.rootNode, [profile.ifNode])) {
    const truth = constantTruth(ifNode.childForFieldName('condition'), profile);
    if (truth === false) {
      const body = ifBody(ifNode, profile);
      if (body) {
        out.push(nodeRange(body));
      }
    } else if (truth === true) {
      const alternative = elseBlock(ifNode, profile);
      if (alternative) {
        out.push(nodeRange(alternative));
      }
    }
  }
  return out;
}

export const structuralPack: RulePack = {
  id: 'structural',
  languages: LANGUAGES,
  rules: [
    {
      kind: 'analyzer',
      id: 'ast-switch-fallthrough',
      category: 'bug',
      severity: 'warning',
      languages: [
        'javascript',
        'javascriptreact',
        'typescript',
        'typescriptreact',
        'java',
        'php',
      ],
      run: switchFallthrough,
      message: 'Case falls through to the next case.',
      why: 'Without a break, return, throw, or continue the following case runs unexpectedly.',
      fix: 'End the case with break/return/throw, or make the fallthrough explicit and intentional.',
    },
    {
      kind: 'analyzer',
      id: 'ast-duplicate-case',
      category: 'bug',
      severity: 'warning',
      languages: LANGUAGES,
      run: duplicateCase,
      message: 'Duplicate case label.',
      why: 'Only the first matching case can ever run, so the duplicate branch is dead code.',
      fix: 'Remove the duplicate label or merge its statements into the first case.',
    },
    {
      kind: 'analyzer',
      id: 'ast-unreachable-code',
      category: 'bug',
      severity: 'warning',
      languages: LANGUAGES,
      run: unreachableCode,
      message: 'Unreachable code after a jump statement.',
      why: 'Execution never reaches this statement because the block already returned or jumped away.',
      fix: 'Delete the statement or move it before the return, throw, break, or continue.',
    },
    {
      kind: 'analyzer',
      id: 'ast-infinite-loop',
      category: 'bug',
      severity: 'warning',
      languages: LANGUAGES,
      run: infiniteLoop,
      message: 'Loop has no reachable exit.',
      why: 'The loop condition is always true and the body has no break, return, or throw.',
      fix: 'Add a terminating condition or a break/return that the loop can reach.',
    },
    {
      kind: 'ast',
      id: 'ast-nested-ternary',
      category: 'smell',
      severity: 'info',
      languages: [
        'javascript',
        'javascriptreact',
        'typescript',
        'typescriptreact',
        'python',
        'java',
        'php',
      ],
      query: (profile) =>
        `(${profile.ternaryNode} (${profile.ternaryNode})) @match ` +
        `(${profile.ternaryNode} (parenthesized_expression (${profile.ternaryNode}))) @match`,
      capture: 'match',
      message: 'Nested conditional expression.',
      why: 'Nested ternaries are hard to read and easy to mis-evaluate.',
      fix: 'Extract the inner conditional into a named variable or use an if/else statement.',
    },
    {
      kind: 'analyzer',
      id: 'ast-collapsible-if',
      category: 'smell',
      severity: 'info',
      languages: LANGUAGES,
      run: collapsibleIf,
      message: 'If statement can be collapsed.',
      why: 'The outer if has no else and only guards another if, adding a nesting level with no effect.',
      fix: 'Combine the two conditions with && into a single if.',
    },
    {
      kind: 'analyzer',
      id: 'ast-string-concat-in-loop',
      category: 'bug',
      severity: 'warning',
      languages: LANGUAGES,
      run: stringConcatInLoop,
      message: 'String concatenation inside a loop.',
      why: 'Appending to a string each iteration copies the whole string and can become quadratic.',
      fix: 'Collect the parts in an array and join once, or use the language StringBuilder equivalent.',
    },
    {
      kind: 'analyzer',
      id: 'ast-utility-class-constructor',
      category: 'smell',
      severity: 'info',
      languages: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'java'],
      run: utilityClassConstructor,
      message: 'Utility class can be instantiated.',
      why: 'A class with only static members gains nothing from an instance and can be created by mistake.',
      fix: 'Make the constructor private, or replace the class with a module of functions.',
    },
    {
      kind: 'analyzer',
      id: 'ast-identical-if-else',
      category: 'bug',
      severity: 'warning',
      languages: LANGUAGES,
      run: identicalIfElse,
      message: 'If and else branches are identical.',
      why: 'Both branches run the same code, so the condition does not change behavior.',
      fix: 'Remove the redundant branch or fix the condition so the branches differ.',
    },
    {
      kind: 'analyzer',
      id: 'ast-duplicated-condition',
      category: 'smell',
      severity: 'info',
      languages: LANGUAGES,
      run: duplicatedCondition,
      message: 'Condition repeated in the same chain.',
      why: 'The repeated condition makes the later branch redundant or unreachable.',
      fix: 'Remove the duplicate branch or change its condition.',
    },
    {
      kind: 'analyzer',
      id: 'ast-unreachable-branch',
      category: 'bug',
      severity: 'warning',
      languages: LANGUAGES,
      run: unreachableBranch,
      message: 'Dead branch under a constant condition.',
      why: 'The condition always evaluates to the same value, so one branch never runs.',
      fix: 'Remove the dead branch or fix the condition.',
    },
  ],
};
