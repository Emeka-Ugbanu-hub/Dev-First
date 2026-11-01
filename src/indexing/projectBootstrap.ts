import { promises as fs } from 'fs';
import * as path from 'path';
import { formatGitContext, readGitContext } from './gitContext';

interface BootstrapCacheEntry {
  fingerprint: string;
  value: string;
  gitReadAt: number;
}
const cache = new Map<string, BootstrapCacheEntry>();
const GIT_REFRESH_MS = 2500;

/**
 * Read only the small manifest files that identify a workspace. This is
 * intentionally deterministic and cached; it never calls a model.
 */
export async function projectBootstrap(root: string): Promise<string> {
  const candidates = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml'];
  const parts: string[] = [];
  const fingerprints: string[] = [];

  for (const name of candidates) {
    const file = path.join(root, name);
    try {
      const stat = await fs.stat(file);
      fingerprints.push(`${name}:${stat.mtimeMs}:${stat.size}`);
      if (name === 'package.json') {
        const pkg = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, any>;
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        const framework = deps.next ? 'Next.js' : deps.react ? 'React' : deps.vue ? 'Vue' : deps.express ? 'Express' : '';
        const scripts = pkg.scripts ?? {};
        const commands = [scripts.build ? 'build' : '', scripts.test ? 'test' : '', scripts.dev ? 'dev' : scripts.start ? 'start' : '']
          .filter(Boolean);
        parts.push(`Node project${framework ? ` (${framework})` : ''}${pkg.main ? `; entry ${pkg.main}` : ''}${commands.length ? `; scripts ${commands.join(', ')}` : ''}`);
      } else if (name === 'pyproject.toml') {
        parts.push('Python project (pyproject.toml)');
      } else if (name === 'Cargo.toml') {
        parts.push('Rust project (Cargo)');
      } else if (name === 'go.mod') {
        parts.push('Go project');
      } else if (name === 'Gemfile') {
        parts.push('Ruby project');
      } else if (name === 'pom.xml') {
        parts.push('Java Maven project');
      }
    } catch {
      // Missing manifests are normal; continue with the others.
    }
  }

  const fingerprint = fingerprints.join('|');
  const previous = cache.get(root);
  const now = Date.now();
  if (previous?.fingerprint === fingerprint && now - previous.gitReadAt < GIT_REFRESH_MS) {
    return previous.value;
  }
  const gitContext = await readGitContext(root);
  const value = parts.length > 0
    ? `[Project bootstrap — deterministic]\n${parts.join(' — ')}\nUse the codebase index and targeted reads for exact structure.${gitContext ? `\n\n${formatGitContext(gitContext)}` : ''}`
    : gitContext ? formatGitContext(gitContext) : '';
  cache.set(root, { fingerprint, value, gitReadAt: now });
  return value;
}

export function clearProjectBootstrap(root?: string): void {
  if (root) cache.delete(root);
  else cache.clear();
}
