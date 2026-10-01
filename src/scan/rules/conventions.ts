import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from '../languages/profiles';
import type { RulePack, ScanRange } from '../ruleTypes';
import { nodeRange } from '../treeSitter';
import { bodyOf, descendantsOf, functionsOf, named } from './analyzerUtils';

const JS_LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];
const CLASS_LANGUAGES = [...JS_LANGUAGES, 'python', 'java', 'php'];
const STRING_LANGUAGES = [...JS_LANGUAGES, 'python', 'java', 'go', 'php'];
const IMPORT_LANGUAGES = [...JS_LANGUAGES, 'python', 'java'];

interface ImportBinding {
  node: Node;
  name: string;
}

function javaOptionalGet(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  if (profile.language !== 'java') {
    return out;
  }
  const optionals = new Set<string>();
  for (const declaration of descendantsOf(tree.rootNode, ['local_variable_declaration'])) {
    const type = declaration.childForFieldName('type');
    if (!type || !/Optional\s*</.test(type.text)) {
      continue;
    }
    for (const declarator of named(declaration, profile)) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const name = declarator.childForFieldName('name');
      if (name?.type === 'identifier') {
        optionals.add(name.text);
      }
    }
  }
  if (optionals.size === 0) {
    return out;
  }
  for (const call of descendantsOf(tree.rootNode, ['method_invocation'])) {
    if (call.childForFieldName('name')?.text !== 'get') {
      continue;
    }
    const object = call.childForFieldName('object');
    if (!object || object.type !== 'identifier' || !optionals.has(object.text)) {
      continue;
    }
    if (hasOptionalGuard(call, object.text)) {
      continue;
    }
    out.push(nodeRange(call));
  }
  return out;
}

function hasOptionalGuard(call: Node, name: string): boolean {
  let scope: Node = call;
  while (
    scope.parent &&
    scope.type !== 'method_declaration' &&
    scope.type !== 'constructor_declaration'
  ) {
    scope = scope.parent;
  }
  for (const invocation of descendantsOf(scope, ['method_invocation'])) {
    const method = invocation.childForFieldName('name')?.text;
    if (method !== 'isPresent' && method !== 'isEmpty') {
      continue;
    }
    const object = invocation.childForFieldName('object');
    if (object?.type === 'identifier' && object.text === name) {
      return true;
    }
  }
  return false;
}

function unusedImport(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const binding of importBindings(tree, profile)) {
    if (binding.name.startsWith('_') || binding.name === '*') {
      continue;
    }
    if (!isReferenced(tree, binding.name, profile)) {
      out.push(nodeRange(binding.node));
    }
  }
  return out;
}

function importBindings(tree: Tree, profile: LanguageProfile): ImportBinding[] {
  if (profile.language === 'javascript' || profile.language === 'typescript') {
    return jsImportBindings(tree);
  }
  if (profile.language === 'python') {
    return pythonImportBindings(tree, profile);
  }
  if (profile.language === 'java') {
    return javaImportBindings(tree, profile);
  }
  return [];
}

function jsImportBindings(tree: Tree): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const statement of descendantsOf(tree.rootNode, ['import_statement'])) {
    const clause = statement.namedChildren.find((child) => child?.type === 'import_clause');
    if (!clause) {
      continue;
    }
    for (const child of clause.namedChildren) {
      if (!child) {
        continue;
      }
      if (child.type === 'identifier') {
        out.push({ node: child, name: child.text });
      } else if (child.type === 'named_imports') {
        for (const specifier of child.namedChildren) {
          if (!specifier || specifier.type !== 'import_specifier') {
            continue;
          }
          const binding = specifier.childForFieldName('alias') ?? specifier.childForFieldName('name');
          if (binding) {
            out.push({ node: binding, name: binding.text });
          }
        }
      }
    }
  }
  return out;
}

function pythonImportBindings(tree: Tree, profile: LanguageProfile): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const statement of descendantsOf(tree.rootNode, ['import_statement'])) {
    for (const child of named(statement, profile)) {
      addPythonBinding(child, out);
    }
  }
  for (const statement of descendantsOf(tree.rootNode, ['import_from_statement'])) {
    for (const child of named(statement, profile).slice(1)) {
      addPythonBinding(child, out);
    }
  }
  return out;
}

function addPythonBinding(node: Node, out: ImportBinding[]): void {
  if (node.type === 'wildcard_import') {
    return;
  }
  if (node.type === 'aliased_import') {
    const binding = node.childForFieldName('alias') ?? node.childForFieldName('name');
    if (binding) {
      out.push({ node: binding, name: binding.text });
    }
    return;
  }
  if (node.type === 'dotted_name') {
    const segments = node.namedChildren.filter((child): child is Node => child !== null);
    if (segments.length === 1) {
      out.push({ node: segments[0], name: segments[0].text });
    }
  }
}

function javaImportBindings(tree: Tree, profile: LanguageProfile): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const statement of descendantsOf(tree.rootNode, ['import_declaration'])) {
    if (statement.text.includes('*')) {
      continue;
    }
    const children = named(statement, profile);
    const target = children[children.length - 1];
    if (!target) {
      continue;
    }
    if (target.type === 'scoped_identifier') {
      const name = target.childForFieldName('name');
      if (name) {
        out.push({ node: name, name: name.text });
      }
    } else if (target.type === 'identifier') {
      out.push({ node: target, name: target.text });
    }
  }
  return out;
}

function isReferenced(tree: Tree, name: string, profile: LanguageProfile): boolean {
  for (const node of descendantsOf(tree.rootNode, referenceTypes(profile))) {
    if (node.text === name && !insideImport(node)) {
      return true;
    }
  }
  return false;
}

function referenceTypes(profile: LanguageProfile): string[] {
  if (profile.language === 'java') {
    return ['identifier', 'type_identifier'];
  }
  if (profile.language === 'javascript' || profile.language === 'typescript') {
    return [
      'identifier',
      'type_identifier',
      'shorthand_property_identifier',
      'shorthand_property_identifier_pattern',
    ];
  }
  return ['identifier'];
}

function insideImport(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (
      current.type === 'import_statement' ||
      current.type === 'import_from_statement' ||
      current.type === 'import_declaration'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function duplicatedString(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const groups = new Map<string, Node[]>();
  for (const node of descendantsOf(tree.rootNode, profile.stringNode)) {
    if (descendantsOf(node, ['template_substitution', 'interpolation', 'variable_name']).length > 0) {
      continue;
    }
    const content = literalContent(node);
    if (content.length < 8) {
      continue;
    }
    const list = groups.get(content);
    if (list) {
      list.push(node);
    } else {
      groups.set(content, [node]);
    }
  }
  const out: ScanRange[] = [];
  for (const nodes of groups.values()) {
    if (nodes.length >= 3) {
      for (const node of nodes.slice(1)) {
        out.push(nodeRange(node));
      }
    }
  }
  return out;
}

function literalContent(node: Node): string {
  const match = /^[A-Za-z]{0,2}(['"`])([\s\S]*)\1$/.exec(node.text);
  return match ? match[2] : '';
}

function lockUnreleased(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const out: ScanRange[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const body = bodyOf(fn);
    if (!body) {
      continue;
    }
    for (const call of descendantsOf(body, ['method_invocation'])) {
      if (call.childForFieldName('name')?.text !== 'lock') {
        continue;
      }
      const object = call.childForFieldName('object');
      if (!object || object.type !== 'identifier') {
        continue;
      }
      if (hasFinallyUnlock(body, object.text, profile)) {
        continue;
      }
      out.push(nodeRange(call));
    }
  }
  return out;
}

function hasFinallyUnlock(body: Node, name: string, profile: LanguageProfile): boolean {
  for (const tryNode of descendantsOf(body, ['try_statement'])) {
    const finallyClause = named(tryNode, profile).find((child) => child.type === 'finally_clause');
    if (!finallyClause) {
      continue;
    }
    for (const call of descendantsOf(finallyClause, ['method_invocation'])) {
      if (call.childForFieldName('name')?.text !== 'unlock') {
        continue;
      }
      const object = call.childForFieldName('object');
      if (object?.type === 'identifier' && object.text === name) {
        return true;
      }
    }
  }
  return false;
}

function htmlDuplicateId(_tree: Tree, _profile: LanguageProfile, text: string): ScanRange[] {
  const out: ScanRange[] = [];
  const seen = new Set<string>();
  const pattern = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[1] ?? match[2] ?? '';
    if (!value) {
      continue;
    }
    if (seen.has(value)) {
      out.push(rangeAt(text, match.index, match.index + match[0].length));
    } else {
      seen.add(value);
    }
  }
  return out;
}

function cssDuplicateSelector(_tree: Tree, _profile: LanguageProfile, text: string): ScanRange[] {
  const out: ScanRange[] = [];
  const seen = new Set<string>();
  const source = blankCssComments(text);
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '{') {
      if (depth === 0) {
        const raw = source.slice(start, index);
        const selector = raw.trim().replace(/\s+/g, ' ');
        if (selector && !selector.startsWith('@')) {
          if (seen.has(selector)) {
            const offset = raw.length - raw.trimStart().length;
            out.push(rangeAt(source, start + offset, start + offset + selector.length));
          } else {
            seen.add(selector);
          }
        }
      }
      depth++;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        start = index + 1;
      }
    }
  }
  return out;
}

function blankCssComments(text: string): string {
  const chars = text.split('');
  let index = 0;
  while (index < text.length) {
    if (text[index] === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let i = index; i < stop; i++) {
        chars[i] = text[i] === '\n' ? '\n' : ' ';
      }
      index = stop;
    } else {
      index++;
    }
  }
  return chars.join('');
}

function rangeAt(text: string, start: number, end: number): ScanRange {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < start; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  const lineEnd = text.indexOf('\n', start);
  const capped = lineEnd === -1 ? end : Math.min(end, lineEnd);
  return { line, startChar: start - lineStart, endChar: capped - lineStart };
}

export const conventionsPack: RulePack = {
  id: 'conventions',
  rules: [
    {
      id: 'scan-naming-class',
      category: 'smell',
      severity: 'info',
      languages: CLASS_LANGUAGES,
      pattern: /class\s+[a-z]\w*/,
      message: 'Class name does not start with an uppercase letter.',
      why: 'Classes are types, and the usual convention makes that visible at the call site.',
      fix: 'Rename the class in PascalCase, e.g. ClassName.',
    },
    {
      id: 'scan-naming-function',
      category: 'smell',
      severity: 'info',
      languages: [...JS_LANGUAGES, 'python', 'java', 'php'],
      pattern:
        /\bfunction\s+[A-Z]\w*\s*\(|\bdef\s+\w*[A-Z]\w*\s*\(|(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)+[\w$<>\[\],.]+\s+[A-Z]\w*\s*\(/,
      message: 'Function or method name uses the wrong case.',
      why: 'Methods are usually lowerCamelCase (snake_case in Python), and an uppercase first letter reads like a type.',
      fix: 'Rename the function in the convention for the language.',
    },
    {
      id: 'scan-naming-constant',
      category: 'smell',
      severity: 'info',
      languages: ['java'],
      pattern: /static\s+final\s+[\w$<>\[\],.]+\s+(?![A-Z0-9_]+\s*[=;])\w+\s*[=;]/,
      message: 'Constant is not named in UPPER_SNAKE_CASE.',
      why: 'A static final field is a constant, and the uppercase convention marks it as one.',
      fix: 'Rename the field in UPPER_SNAKE_CASE, e.g. MAX_RETRIES.',
    },
    {
      id: 'scan-wildcard-import',
      category: 'smell',
      severity: 'info',
      languages: ['java', 'python'],
      pattern: /import\s+[\w.]+\.\*;|from\s+\S+\s+import\s+\*/,
      message: 'Wildcard import.',
      why: 'Wildcard imports hide where names come from and can silently change meaning when a dependency adds a name.',
      fix: 'Import the specific names that are used.',
    },
    {
      id: 'scan-magic-number',
      category: 'smell',
      severity: 'info',
      languages: [...JS_LANGUAGES, 'java', 'python'],
      pattern: /(?:[=!]==|[=!]=|[<>]=?)\s*(?!(?:-1|0|1|2)(?![\d.]))-?\d+(?:\.\d+)?/,
      message: 'Magic number in a comparison.',
      why: 'A literal with no name hides the intent and must be updated in every copy when it changes.',
      fix: 'Extract the number into a named constant.',
    },
    {
      kind: 'analyzer',
      id: 'scan-java-optional-get',
      category: 'bug',
      severity: 'warning',
      languages: ['java'],
      run: javaOptionalGet,
      message: 'Optional.get() called without a presence check.',
      why: 'Calling get() on an empty Optional throws NoSuchElementException, and no isPresent() or isEmpty() guard was found.',
      fix: 'Check isPresent() first or use orElse/orElseThrow.',
    },
    {
      kind: 'analyzer',
      id: 'scan-unused-import',
      category: 'smell',
      severity: 'info',
      languages: IMPORT_LANGUAGES,
      run: unusedImport,
      message: 'Imported binding is never used.',
      why: 'An unused import adds noise and can mask a rename or a forgotten reference.',
      fix: 'Remove the import, or use the binding it introduces.',
    },
    {
      kind: 'analyzer',
      id: 'scan-duplicated-string',
      category: 'smell',
      severity: 'info',
      languages: STRING_LANGUAGES,
      run: duplicatedString,
      message: 'String literal repeated three or more times.',
      why: 'Copies of the same literal drift apart and are easy to miss when the value changes.',
      fix: 'Extract the literal into a named constant and reuse it.',
    },
    {
      kind: 'analyzer',
      id: 'scan-lock-unreleased',
      category: 'bug',
      severity: 'warning',
      languages: ['java'],
      run: lockUnreleased,
      message: 'Lock acquired without an unlock in a finally block.',
      why: 'If an exception is thrown while the lock is held, it stays locked and can deadlock other threads.',
      fix: 'Release the lock in a finally block, or use try-with-resources with a lock wrapper.',
    },
    {
      kind: 'analyzer',
      id: 'scan-html-duplicate-id',
      category: 'bug',
      severity: 'warning',
      languages: ['html'],
      run: htmlDuplicateId,
      message: 'Duplicate id attribute value.',
      why: 'Ids must be unique in a document, and duplicates break label targeting, anchors, and DOM lookups.',
      fix: 'Give each element a unique id or switch to a class where possible.',
    },
    {
      kind: 'analyzer',
      id: 'scan-css-duplicate-selector',
      category: 'smell',
      severity: 'info',
      languages: ['css'],
      run: cssDuplicateSelector,
      message: 'Duplicate CSS selector.',
      why: 'Repeating a selector splits its declarations and makes the cascade harder to reason about.',
      fix: 'Merge the declarations into the first rule.',
    },
  ],
};
