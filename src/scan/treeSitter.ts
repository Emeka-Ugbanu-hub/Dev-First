import * as path from 'path';
import type { Language, Node, Parser, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { ScanRange } from './ruleTypes';

interface TreeSitterRuntime {
  Parser: {
    init(options: { locateFile: (file: string, folder: string) => string }): Promise<void>;
    new (): Parser;
  };
  Language: {
    load(input: string | Uint8Array): Promise<Language>;
  };
}

export interface TreeSitterHost {
  extensionUri: { fsPath: string };
}

const GRAMMARS: Record<string, string> = {
  javascript: 'tree-sitter-javascript.wasm',
  javascriptreact: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  typescriptreact: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
  go: 'tree-sitter-go.wasm',
  php: 'tree-sitter-php.wasm',
  rust: 'tree-sitter-rust.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  bash: 'tree-sitter-bash.wasm',
  shellscript: 'tree-sitter-bash.wasm',
  powershell: 'tree-sitter-powershell.wasm',
  csharp: 'tree-sitter-c-sharp.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  c: 'tree-sitter-cpp.wasm',
  css: 'tree-sitter-css.wasm',
  ini: 'tree-sitter-ini.wasm',
};

export class TreeSitterService {
  private runtimePromise: Promise<TreeSitterRuntime> | undefined;
  private readonly languagePromises = new Map<string, Promise<Language | undefined>>();
  private readonly parsers = new Map<string, Parser>();

  constructor(private readonly host: TreeSitterHost) {}

  private wasmDir(): string {
    return path.join(this.host.extensionUri.fsPath, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
  }

  private loadRuntime(): Promise<TreeSitterRuntime> {
    if (!this.runtimePromise) {
      this.runtimePromise = (async () => {
        const runtime = require('@vscode/tree-sitter-wasm') as TreeSitterRuntime;
        await runtime.Parser.init({ locateFile: (file) => path.join(this.wasmDir(), file) });
        return runtime;
      })();
    }
    return this.runtimePromise;
  }

  getLanguage(languageId: string): Promise<Language | undefined> {
    const grammar = GRAMMARS[languageId];
    if (!grammar) {
      return Promise.resolve(undefined);
    }
    let pending = this.languagePromises.get(languageId);
    if (!pending) {
      pending = this.loadRuntime()
        .then((runtime) => runtime.Language.load(path.join(this.wasmDir(), grammar)))
        .catch(() => undefined);
      this.languagePromises.set(languageId, pending);
    }
    return pending;
  }

  async parse(text: string, languageId: string): Promise<Tree | undefined> {
    const language = await this.getLanguage(languageId);
    if (!language) {
      return undefined;
    }
    try {
      let parser = this.parsers.get(languageId);
      if (!parser) {
        const runtime = await this.loadRuntime();
        parser = new runtime.Parser();
        parser.setLanguage(language);
        this.parsers.set(languageId, parser);
      }
      return parser.parse(text) ?? undefined;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    for (const parser of this.parsers.values()) {
      parser.delete();
    }
    this.parsers.clear();
    this.languagePromises.clear();
  }
}

export function nodeRange(node: Node): ScanRange {
  const line = node.startPosition.row;
  const startChar = node.startPosition.column;
  const endChar =
    node.endPosition.row === line ? node.endPosition.column : startChar + firstLineLength(node.text);
  return { line, startChar, endChar };
}

function firstLineLength(text: string): number {
  const index = text.indexOf('\n');
  return index === -1 ? text.length : index;
}
