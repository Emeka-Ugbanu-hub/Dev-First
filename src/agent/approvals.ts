import * as path from 'path';

export function commandApprovalPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return '';
  }
  return `${tokens.slice(0, 2).join(' ')} *`;
}

export class ApprovalMemory {
  private readonly prefixes = new Set<string>();

  allows(command: string): boolean {
    const prefix = commandApprovalPrefix(command);
    return prefix !== '' && this.prefixes.has(prefix);
  }

  remember(command: string): void {
    const prefix = commandApprovalPrefix(command);
    if (prefix) {
      this.prefixes.add(prefix);
    }
  }

  clear(): void {
    this.prefixes.clear();
  }

  get size(): number {
    return this.prefixes.size;
  }
}

export class ExternalDirectoryConsent {
  private readonly directories = new Set<string>();

  allows(directory: string): boolean {
    return this.directories.has(path.resolve(directory));
  }

  grant(directory: string): void {
    this.directories.add(path.resolve(directory));
  }

  clear(): void {
    this.directories.clear();
  }
}
