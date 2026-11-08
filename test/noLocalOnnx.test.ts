import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

describe('embedding worker isolation', () => {
  it('keeps the native embedding runtime out of the extension host', () => {
    const root = path.resolve(__dirname, '..');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@huggingface/transformers']).toBeDefined();
    expect(existsSync(path.join(root, 'src', 'indexing', 'LocalEmbedder.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src', 'indexing', 'embedWorker.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'resources', 'models', 'all-MiniLM-L6-v2', 'onnx', 'model.onnx'))).toBe(true);

    const controller = readFileSync(path.join(root, 'src', 'session', 'SessionController.ts'), 'utf-8');
    expect(controller).not.toContain('LocalEmbedder');
    expect(controller).not.toContain('@huggingface/transformers');
    expect(controller).toContain('EmbedWorkerClient');

    const esbuild = readFileSync(path.join(root, 'esbuild.mjs'), 'utf-8');
    expect(esbuild).toContain('src/indexing/embedWorker.ts');
  });
});
