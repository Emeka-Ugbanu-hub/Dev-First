import * as path from 'path';
import { createHash } from 'crypto';

/**
 * Return a stable extension-storage path scoped to one workspace. Extension
 * global storage is shared by every VS Code workspace, so project data must
 * include the resolved workspace identity in its path.
 */
export function workspaceStoragePath(storageRoot: string, workspaceRoot: string, ...segments: string[]): string {
  const identity = path.resolve(workspaceRoot);
  const workspaceKey = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return path.join(storageRoot, 'workspaces', workspaceKey, ...segments);
}
