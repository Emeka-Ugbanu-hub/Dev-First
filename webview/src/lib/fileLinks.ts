let knownFiles = new Set<string>();

export function setKnownFiles(files: string[]): void {
  knownFiles = new Set(files.map((file) => file.replace(/^\.\//, '')));
}

export function parseFileToken(text: string): { path: string; line?: number } | undefined {
  const trimmed = text.trim();
  const match = /^([\w@./-]+\.[a-z0-9]{1,8})(?::(\d+))?$/i.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const filePath = match[1].replace(/^\.\//, '');
  if (!filePath.includes('/') && !filePath.includes('.')) {
    return undefined;
  }
  return { path: filePath, line: match[2] ? Number(match[2]) : undefined };
}

export function isKnownFile(filePath: string): boolean {
  return knownFiles.has(filePath);
}
