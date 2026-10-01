import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from './languages/profiles';

export interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
  structural: boolean;
}

export interface ChunkOptions {
  maxTokens?: number;
  windowLines?: number;
  overlapLines?: number;
}

export const CHUNK_MAX_TOKENS = 8000;
export const CHUNK_WINDOW_LINES = 400;
export const CHUNK_OVERLAP_LINES = 10;
const MAX_SIGNATURES = 200;

const COMMENT_TYPES = new Set(['comment', 'line_comment', 'block_comment', 'hash_bang_line']);
const IMPORT_TYPES = new Set([
  'import_statement',
  'import_from_statement',
  'future_import_statement',
  'import_declaration',
  'import_spec',
  'import_spec_list',
  'package_clause',
  'package_declaration',
  'use_declaration',
  'using_declaration',
  'namespace_use_declaration',
  'namespace_use_clause',
  'include_directive',
  'export_clause',
  'named_exports',
]);
const TYPE_DECL_TYPES = new Set([
  'type_alias_declaration',
  'interface_declaration',
  'enum_declaration',
  'type_declaration',
  'module_declaration',
  'namespace_definition',
  'internal_module',
  'type_definition',
  'type_spec',
  'struct_spec',
  'enum_spec',
  'annotation_type_declaration',
]);
const VARIABLE_TYPES = new Set([
  'lexical_declaration',
  'variable_declaration',
  'const_declaration',
  'let_declaration',
  'field_declaration',
  'property_declaration',
  'const_item',
  'static_item',
  'var_declaration',
  'var_spec',
  'const_spec',
  'const_spec_list',
  'var_spec_list',
]);
const WRAPPER_TYPES = new Set([
  'export_statement',
  'ambient_declaration',
  'declare_statement',
  'decorated_definition',
]);

const IMPORT_LINE =
  /^(?:import\b|from\b|#include\b|using\b|package\b|require\s*\(|use\s+[\w:])/;
const TYPE_LINE =
  /^(?:export\s+|declare\s+|default\s+|abstract\s+|public\s+|private\s+|protected\s+|static\s+|final\s+|open\s+|sealed\s+|partial\s+)*(?:type|interface|enum|struct|trait|union|namespace|module|record|typedef|impl)\b/;
const CONST_LINE =
  /^(?:export\s+|declare\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|readonly\s+|final\s+)*(?:const|let|var)\s+[\w$#]+/;
const PUNCT_LINE = /^[{}()[\];,<>|&=+\-*.\s]+$/;
const EXECUTABLE_LINE = /=>|\bfunction\b|\bclass\b|\bnew\b|\breturn\b|\bawait\b|\bthrow\b|\(/;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function chunkFile(
  text: string,
  tree: Tree | undefined,
  profile: LanguageProfile | undefined,
  options: ChunkOptions = {},
): Chunk[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split('\n');
  const maxTokens = Math.max(1, options.maxTokens ?? CHUNK_MAX_TOKENS);
  if (!tree || !profile) {
    return lineWindows(
      lines,
      options.windowLines ?? CHUNK_WINDOW_LINES,
      options.overlapLines ?? CHUNK_OVERLAP_LINES,
    );
  }
  const nodes = topLevelNodes(tree.rootNode);
  if (nodes.length === 0) {
    return lineWindows(
      lines,
      options.windowLines ?? CHUNK_WINDOW_LINES,
      options.overlapLines ?? CHUNK_OVERLAP_LINES,
    );
  }
  const chunks: Chunk[] = [];
  let start = 0;
  let end = -1;
  let tokens = 0;
  let structural = true;
  for (const node of nodes) {
    const nodeTokens = estimateTokens(node.text);
    if (end >= start && tokens + nodeTokens > maxTokens) {
      chunks.push(makeChunk(lines, start, end, structural));
      start = end + 1;
      tokens = 0;
      structural = true;
    }
    end = Math.max(end, node.endPosition.row);
    tokens += nodeTokens;
    structural = structural && isStructuralNode(node, profile);
  }
  if (end >= start) {
    chunks.push(makeChunk(lines, start, end, structural));
  }
  const last = chunks[chunks.length - 1];
  if (last && last.endLine < lines.length - 1) {
    chunks[chunks.length - 1] = makeChunk(lines, last.startLine, lines.length - 1, last.structural);
  }
  return chunks;
}

function topLevelNodes(root: Node): Node[] {
  const out: Node[] = [];
  for (const child of root.namedChildren) {
    if (child) {
      out.push(child);
    }
  }
  return out;
}

function makeChunk(lines: string[], startLine: number, endLine: number, structural: boolean): Chunk {
  return {
    startLine,
    endLine,
    text: lines.slice(startLine, endLine + 1).join('\n'),
    structural,
  };
}

function lineWindows(lines: string[], windowLines: number, overlapLines: number): Chunk[] {
  const size = Math.max(1, windowLines);
  const overlap = Math.max(0, Math.min(overlapLines, size - 1));
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(lines.length - 1, start + size - 1);
    chunks.push(
      makeChunk(lines, start, end, classifyLines(lines.slice(start, end + 1))),
    );
    if (end >= lines.length - 1) {
      break;
    }
    start = end + 1 - overlap;
  }
  return chunks;
}

export function isStructuralNode(node: Node, profile: LanguageProfile): boolean {
  const type = node.type;
  if (COMMENT_TYPES.has(type) || profile.commentNode.includes(type)) {
    return true;
  }
  if (IMPORT_TYPES.has(type) || TYPE_DECL_TYPES.has(type)) {
    return true;
  }
  if (type === 'export_statement') {
    const declaration = node.childForFieldName('declaration');
    if (declaration) {
      return isStructuralNode(declaration, profile);
    }
    const value = node.childForFieldName('value');
    if (value) {
      return isStructuralNode(value, profile);
    }
    return true;
  }
  if (WRAPPER_TYPES.has(type)) {
    const inner =
      node.childForFieldName('declaration') ??
      node.childForFieldName('definition') ??
      node.childForFieldName('value') ??
      lastNamed(node);
    return inner ? isStructuralNode(inner, profile) : true;
  }
  if (VARIABLE_TYPES.has(type)) {
    return variableIsStructural(node);
  }
  if (type === 'expression_statement') {
    return expressionIsStructural(node);
  }
  return false;
}

function variableIsStructural(node: Node): boolean {
  for (const child of node.namedChildren) {
    if (!child) {
      continue;
    }
    if (
      child.type === 'variable_declarator' ||
      child.type === 'init_declarator' ||
      child.type === 'assignment' ||
      child.type === 'const_spec' ||
      child.type === 'var_spec'
    ) {
      const value = child.childForFieldName('value') ?? child.childForFieldName('right');
      if (value && !isConstantValue(value)) {
        return false;
      }
      continue;
    }
    if (VARIABLE_TYPES.has(child.type) && !variableIsStructural(child)) {
      return false;
    }
  }
  return true;
}

function expressionIsStructural(node: Node): boolean {
  const child = node.namedChildren.find((candidate) => candidate !== null);
  if (!child) {
    return false;
  }
  if (child.type === 'string') {
    return true;
  }
  if (child.type === 'assignment') {
    const right = child.childForFieldName('right');
    return !right || isConstantValue(right);
  }
  return false;
}

function isConstantValue(node: Node): boolean {
  switch (node.type) {
    case 'arrow_function':
    case 'function':
    case 'function_expression':
    case 'function_declaration':
    case 'generator_function':
    case 'generator_function_declaration':
    case 'call_expression':
    case 'new_expression':
    case 'await_expression':
    case 'yield_expression':
    case 'class':
    case 'class_expression':
    case 'class_declaration':
    case 'method_definition':
      return false;
    case 'template_string':
      return !node.namedChildren.some((child) => child?.type === 'template_substitution');
    case 'array':
    case 'object':
    case 'parenthesized_expression':
    case 'tuple':
    case 'list':
    case 'dictionary':
    case 'set':
      return node.namedChildren.every((child) => !child || isConstantValue(child));
    default:
      return true;
  }
}

function lastNamed(node: Node): Node | undefined {
  for (let index = node.namedChildren.length - 1; index >= 0; index--) {
    const child = node.namedChildren[index];
    if (child) {
      return child;
    }
  }
  return undefined;
}

export function classifyLines(lines: string[]): boolean {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
      continue;
    }
    if (IMPORT_LINE.test(line) || TYPE_LINE.test(line) || PUNCT_LINE.test(line)) {
      continue;
    }
    if (CONST_LINE.test(line) && !EXECUTABLE_LINE.test(line)) {
      continue;
    }
    return false;
  }
  return true;
}

export function signaturesOf(text: string, profile: LanguageProfile | undefined): string[] {
  const language = profile?.language ?? '';
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (out.length >= MAX_SIGNATURES) {
      break;
    }
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
      continue;
    }
    if (isSignatureLine(line, language)) {
      out.push(line);
    }
  }
  return out;
}

function isSignatureLine(line: string, language: string): boolean {
  if (language === 'python') {
    return (
      /^(?:async\s+)?def\s/.test(line) ||
      /^class\s/.test(line) ||
      /^(?:import|from)\s/.test(line) ||
      /^[A-Z][A-Z0-9_]*\s*[:=]/.test(line)
    );
  }
  if (language === 'go') {
    return /^(?:func|type|import|package|const|var)\b/.test(line);
  }
  if (language === 'java') {
    return (
      /^(?:package|import)\b/.test(line) ||
      /^(?:public|private|protected|static|final|abstract|sealed|non-sealed|synchronized|native|default|\s)*(?:class|interface|enum|record|@interface)\b/.test(
        line,
      ) ||
      /^(?:public|private|protected|static|final|abstract|synchronized|native|default|\s)*[\w<>[\],.?]+\s+\w+\s*\([^;{]*\)\s*(?:throws\s+[\w.,\s]+)?\s*\{?\s*$/.test(
        line,
      )
    );
  }
  if (language === 'php') {
    return (
      /^(?:namespace|use|class|interface|trait|enum|function|const|abstract|final)\b/.test(line) ||
      /^(?:public|private|protected|static|abstract|final|\s)*function\s+\w+\s*\(/.test(line)
    );
  }
  return (
    /^(?:import\b|export\s+.*\bfrom\b)/.test(line) ||
    /^(?:export\s+|declare\s+|default\s+)*(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|namespace|abstract\s+class)\b/.test(
      line,
    ) ||
    /^[\w$#[\]]+\s*\([^;]*\)\s*(?::\s*[^{]+)?\{?\s*$/.test(line)
  );
}
