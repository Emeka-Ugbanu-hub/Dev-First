export function parseWorktreeInclude(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map(normalizePattern)
    .filter((line) => line !== '');
}

export function matchesWorktreeInclude(pattern: string, relativePath: string): boolean {
  const target = normalizePattern(pattern);
  if (!target) {
    return false;
  }
  return globToRegExp(target).test(normalizePath(relativePath));
}

export function includeBaseDir(pattern: string): string {
  const normalized = normalizePattern(pattern);
  const star = normalized.indexOf('*');
  const prefix = star === -1 ? normalized : normalized.slice(0, star);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '' : prefix.slice(0, slash);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function normalizePattern(value: string): string {
  return normalizePath(value).replace(/\/+$/, '');
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}
