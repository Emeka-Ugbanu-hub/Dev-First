import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_RULES_CHARS = 20_000;
const WORKSPACE_CANDIDATES = ['AGENTS.md', '.dev-first/rules.md'];

export async function loadProjectRules(root: string | undefined): Promise<string | undefined> {
  const parts: string[] = [];

  if (root) {
    for (const candidate of WORKSPACE_CANDIDATES) {
      const content = await readIfExists(path.join(root, candidate));
      if (content?.trim()) {
        parts.push(content.trim());
      }
    }
  }

  const globalRules = await readIfExists(path.join(os.homedir(), '.dev-first', 'AGENTS.md'));
  if (globalRules?.trim()) {
    parts.push(globalRules.trim());
  }

  if (parts.length === 0) {
    return undefined;
  }
  const combined = parts.join('\n\n---\n\n');
  return combined.length > MAX_RULES_CHARS
    ? `${combined.slice(0, MAX_RULES_CHARS)}\n... [truncated]`
    : combined;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}
