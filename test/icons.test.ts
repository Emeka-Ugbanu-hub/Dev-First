import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const codiconCss = readFileSync(
  path.join(root, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
  'utf-8',
);

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (full.endsWith('.tsx') || full.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function exists(name: string): boolean {
  return codiconCss.includes(`.codicon-${name}:before`);
}

describe('codicon usage', () => {
  it('every static codicon- class in source exists in the font', () => {
    const files = [
      ...collectSourceFiles(path.join(root, 'webview', 'src')),
      ...collectSourceFiles(path.join(root, 'src')),
    ];
    const used = new Set<string>();
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const regex = /codicon-([a-z0-9-]+)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        used.add(match[1]);
      }
    }
    for (const name of used) {
      if (name.endsWith('-') || name === 'modifier-spin') {
        continue;
      }
      expect(exists(name), `codicon-${name} is not in the font`).toBe(true);
    }
    expect(used.size).toBeGreaterThan(10);
  });

  it('dynamic icon names used by tools, todos, and examples exist', () => {
    const dynamic = [
      'file',
      'files',
      'search',
      'search-fuzzy',
      'globe',
      'new-file',
      'edit',
      'diff',
      'terminal',
      'checklist',
      'question',
      'book',
      'save',
      'server-process',
      'browser',
      'plug',
      'symbol-method',
      'list-tree',
      'references',
      'tools',
      'check',
      'sync',
      'circle-outline',
      'shield',
      'loading',
      'eye',
      'info',
      'settings',
      'wand',
      'cloud-upload',
      'history',
      'redo',
      'trash',
      'quote',
      'selection',
      'send',
      'debug-stop',
      'play',
      'add',
      'close',
      'copy',
      'arrow-down',
      'arrow-up',
      'chevron-down',
      'chevron-right',
      'chevron-up',
      'go-to-file',
      'repo-push',
      'unlock',
      'terminal-cmd',
      'lightbulb',
      'warning',
    ];
    for (const name of dynamic) {
      expect(exists(name), `codicon-${name} is not in the font`).toBe(true);
    }
  });
});
