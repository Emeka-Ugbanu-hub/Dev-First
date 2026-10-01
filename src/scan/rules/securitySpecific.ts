import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from '../languages/profiles';
import type { RulePack, ScanRange } from '../ruleTypes';
import { nodeRange } from '../treeSitter';
import {
  SCAN_LANGUAGES,
  descendantsOf,
  isFalseLiteral,
  isJsLike,
  named,
  stringContent,
} from './analyzerUtils';

const JS_LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];
const REGEX_LANGUAGES = [...JS_LANGUAGES, 'python', 'java'];
const REDIRECT_LANGUAGES = [...JS_LANGUAGES, 'python', 'java', 'php'];
const SESSION_LANGUAGES = [...JS_LANGUAGES, 'python'];

interface RegexGroup {
  content: string;
  end: number;
}

function nestedQuantifier(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  if (isJsLike(profile)) {
    for (const node of descendantsOf(tree.rootNode, ['regex'])) {
      const pattern = node.namedChildren.find((child) => child?.type === 'regex_pattern');
      if (pattern && hasNestedQuantifier(pattern.text)) {
        out.push(nodeRange(node));
      }
    }
  }
  if (profile.language === 'python') {
    for (const call of descendantsOf(tree.rootNode, ['call'])) {
      const fn = call.childForFieldName('function');
      if (!fn || fn.type !== 'attribute') {
        continue;
      }
      const object = fn.childForFieldName('object');
      const attribute = fn.childForFieldName('attribute');
      if (object?.text !== 're' || !attribute || !reApi(attribute.text)) {
        continue;
      }
      const first = firstArgument(call, profile);
      if (first?.type === 'string' && hasNestedQuantifier(stringContent(first))) {
        out.push(nodeRange(call));
      }
    }
  }
  if (profile.language === 'java') {
    for (const call of descendantsOf(tree.rootNode, ['method_invocation'])) {
      if (call.childForFieldName('name')?.text !== 'compile') {
        continue;
      }
      if (call.childForFieldName('object')?.text !== 'Pattern') {
        continue;
      }
      const first = firstArgument(call, profile);
      if (first?.type === 'string_literal' && hasNestedQuantifier(stringContent(first))) {
        out.push(nodeRange(call));
      }
    }
  }
  return out;
}

function reApi(name: string): boolean {
  return name === 'compile' || name === 'match' || name === 'search' || name === 'fullmatch';
}

function hasNestedQuantifier(source: string): boolean {
  for (const group of regexGroups(source)) {
    if (!isRepeatedGroup(source, group.end)) {
      continue;
    }
    if (containsUnboundedQuantifier(group.content) || hasOverlappingAlternation(group.content)) {
      return true;
    }
  }
  return false;
}

function regexGroups(source: string): RegexGroup[] {
  const groups: RegexGroup[] = [];
  const stack: number[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (char === ']') {
        inClass = false;
      }
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === '(') {
      stack.push(i);
      continue;
    }
    if (char === ')') {
      const start = stack.pop();
      if (start !== undefined) {
        groups.push({ content: source.slice(start + 1, i), end: i });
      }
    }
  }
  return groups;
}

function isRepeatedGroup(source: string, close: number): boolean {
  const next = source[close + 1];
  if (next === '+' || next === '*') {
    return true;
  }
  if (next !== '{') {
    return false;
  }
  const match = /^\{(\d+)(,(\d*)?)?\}/.exec(source.slice(close + 1));
  return match !== null && (match[2] === undefined || match[3] === '');
}

function containsUnboundedQuantifier(content: string): boolean {
  let inClass = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (char === ']') {
        inClass = false;
      }
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === '+' || char === '*') {
      return true;
    }
    if (char === '{') {
      const match = /^\{(\d+)(,(\d*)?)?\}/.exec(content.slice(i));
      if (match && (match[2] === undefined || match[3] === '')) {
        return true;
      }
    }
  }
  return false;
}

function hasOverlappingAlternation(content: string): boolean {
  const alternatives = splitAlternatives(content);
  if (alternatives.length < 2) {
    return false;
  }
  for (let i = 0; i < alternatives.length; i++) {
    for (let j = 0; j < alternatives.length; j++) {
      if (i !== j && alternatives[i].length > 0 && alternatives[j].startsWith(alternatives[i])) {
        return true;
      }
    }
  }
  return false;
}

function splitAlternatives(content: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (char === ']') {
        inClass = false;
      }
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === '(') {
      depth++;
      continue;
    }
    if (char === ')') {
      depth--;
      continue;
    }
    if (char === '|' && depth === 0) {
      parts.push(content.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(content.slice(start));
  return parts;
}

function openRedirect(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  if (isJsLike(profile)) {
    for (const call of descendantsOf(tree.rootNode, ['call_expression'])) {
      const callee = call.childForFieldName('function');
      if (!callee || callee.type !== 'member_expression') {
        continue;
      }
      const object = callee.childForFieldName('object');
      const property = callee.childForFieldName('property');
      if (property?.text !== 'redirect' || !object || (object.text !== 'res' && object.text !== 'response')) {
        continue;
      }
      const first = firstArgument(call, profile);
      if (first && !isStaticString(first, profile)) {
        out.push(nodeRange(call));
      }
    }
  }
  if (profile.language === 'python') {
    for (const call of descendantsOf(tree.rootNode, ['call'])) {
      const fn = call.childForFieldName('function');
      const name =
        fn?.type === 'identifier'
          ? fn.text
          : fn?.type === 'attribute'
            ? fn.childForFieldName('attribute')?.text
            : undefined;
      if (name !== 'redirect' && name !== 'HttpResponseRedirect') {
        continue;
      }
      const first = firstArgument(call, profile);
      if (first && !isStaticString(first, profile)) {
        out.push(nodeRange(call));
      }
    }
  }
  if (profile.language === 'java') {
    for (const call of descendantsOf(tree.rootNode, ['method_invocation'])) {
      if (call.childForFieldName('name')?.text !== 'sendRedirect') {
        continue;
      }
      const first = firstArgument(call, profile);
      if (first && first.type !== 'string_literal') {
        out.push(nodeRange(call));
      }
    }
  }
  if (profile.language === 'php') {
    for (const call of descendantsOf(tree.rootNode, ['function_call_expression'])) {
      if (call.childForFieldName('function')?.text !== 'header') {
        continue;
      }
      const first = firstArgument(call, profile);
      if (first && isDynamicLocation(first)) {
        out.push(nodeRange(call));
      }
    }
  }
  return out;
}

function isDynamicLocation(node: Node): boolean {
  if (node.type === 'encapsed_string') {
    return node.text.includes('Location:') && descendantsOf(node, ['variable_name']).length > 0;
  }
  if (node.type === 'binary_expression') {
    return (
      node.text.includes('Location:') &&
      (descendantsOf(node, ['variable_name']).length > 0 ||
        descendantsOf(node, ['encapsed_string']).some((part) => part.text.includes('Location:')))
    );
  }
  return false;
}

function isStaticString(node: Node, profile: LanguageProfile): boolean {
  if (isJsLike(profile)) {
    if (node.type === 'string') {
      return true;
    }
    return node.type === 'template_string' && descendantsOf(node, ['template_substitution']).length === 0;
  }
  if (profile.language === 'python') {
    return node.type === 'string' && descendantsOf(node, ['interpolation']).length === 0;
  }
  return false;
}

function sessionFixation(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  if (isJsLike(profile)) {
    for (const call of descendantsOf(tree.rootNode, ['call_expression'])) {
      const fn = call.childForFieldName('function');
      if (!fn || fn.type !== 'identifier' || fn.text !== 'session') {
        continue;
      }
      const first = firstArgument(call, profile);
      if (!first || first.type !== 'object') {
        continue;
      }
      for (const pair of descendantsOf(first, ['pair'])) {
        const key = pair.childForFieldName('key');
        const value = pair.childForFieldName('value');
        if (!key || !value || !isCookieKey(key.text) || !isFalseLiteral(value, profile)) {
          continue;
        }
        out.push(nodeRange(pair));
      }
    }
  }
  if (profile.language === 'python') {
    for (const assignment of descendantsOf(tree.rootNode, ['assignment'])) {
      const left = assignment.childForFieldName('left');
      const right = assignment.childForFieldName('right');
      if (!left || !right || !isFalseLiteral(right, profile) || !isSessionCookieTarget(left)) {
        continue;
      }
      out.push(nodeRange(assignment));
    }
  }
  return out;
}

function isCookieKey(name: string): boolean {
  return name === 'secure' || name === 'httpOnly';
}

function isSessionCookieTarget(node: Node): boolean {
  if (node.type === 'identifier') {
    return /^SESSION_COOKIE_(SECURE|HTTPONLY)$/.test(node.text);
  }
  if (node.type !== 'subscript') {
    return false;
  }
  const value = node.childForFieldName('value');
  const index = node.childForFieldName('subscript');
  if (!value || !index || value.type !== 'attribute') {
    return false;
  }
  if (value.childForFieldName('attribute')?.text !== 'config') {
    return false;
  }
  return index.type === 'string' && /SESSION_COOKIE_(SECURE|HTTPONLY)/.test(index.text);
}

function firstArgument(call: Node, profile: LanguageProfile): Node | undefined {
  const args = call.childForFieldName('arguments');
  if (!args) {
    return undefined;
  }
  const first = named(args, profile)[0];
  if (!first) {
    return undefined;
  }
  if (first.type === 'argument') {
    return named(first, profile)[0];
  }
  return first;
}

export const securitySpecificPack: RulePack = {
  id: 'security-specific',
  languages: SCAN_LANGUAGES,
  rules: [
    {
      kind: 'analyzer',
      id: 'redos-nested-quantifier',
      category: 'vulnerability',
      severity: 'warning',
      languages: REGEX_LANGUAGES,
      run: nestedQuantifier,
      message: 'Regular expression can backtrack catastrophically.',
      why: 'A quantified group that itself contains an unbounded quantifier can take exponential time on crafted input.',
      fix: 'Rewrite the pattern without nested quantifiers, or anchor and bound the repetition.',
    },
    {
      kind: 'analyzer',
      id: 'open-redirect',
      category: 'vulnerability',
      severity: 'warning',
      languages: REDIRECT_LANGUAGES,
      run: openRedirect,
      message: 'Redirect target comes from user input.',
      why: 'Redirecting to an attacker-controlled value enables phishing and token theft through trusted URLs.',
      fix: 'Validate the target against an allowlist of relative paths or trusted hosts.',
    },
    {
      kind: 'analyzer',
      id: 'session-fixation',
      category: 'vulnerability',
      severity: 'warning',
      languages: SESSION_LANGUAGES,
      run: sessionFixation,
      message: 'Session cookie is not protected.',
      why: 'A session cookie without secure/httpOnly flags can be read by scripts or sent over plain HTTP.',
      fix: 'Set secure: true and httpOnly: true (SESSION_COOKIE_SECURE/HTTPONLY = True).',
    },
  ],
};
