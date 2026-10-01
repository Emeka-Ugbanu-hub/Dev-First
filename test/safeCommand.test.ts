import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { isSafeCommand } from '../src/agent/ToolBox';

describe('isSafeCommand', () => {
  it('allows simple read-only commands', () => {
    expect(isSafeCommand('ls -la')).toBe(true);
    expect(isSafeCommand('pwd')).toBe(true);
    expect(isSafeCommand('cat package.json')).toBe(true);
    expect(isSafeCommand('head -n 20 src/index.ts')).toBe(true);
    expect(isSafeCommand('tail logs/app.log')).toBe(true);
    expect(isSafeCommand('wc -l src/index.ts')).toBe(true);
    expect(isSafeCommand('file src/index.ts')).toBe(true);
    expect(isSafeCommand('echo hello world')).toBe(true);
    expect(isSafeCommand('which node')).toBe(true);
    expect(isSafeCommand('whoami')).toBe(true);
    expect(isSafeCommand('date')).toBe(true);
    expect(isSafeCommand('du -sh node_modules')).toBe(true);
    expect(isSafeCommand('df -h')).toBe(true);
    expect(isSafeCommand('grep -r "foo" src')).toBe(true);
    expect(isSafeCommand('rg foo src')).toBe(true);
  });

  it('allows safe command chains and pipes', () => {
    expect(isSafeCommand('ls && pwd')).toBe(true);
    expect(isSafeCommand('cat package.json | grep name')).toBe(true);
    expect(isSafeCommand('git status || git diff')).toBe(true);
    expect(isSafeCommand('ls | wc -l')).toBe(true);
    expect(isSafeCommand('pwd; ls; date')).toBe(true);
    expect(isSafeCommand('git diff && npm test')).toBe(true);
  });

  it('allows read-only git commands', () => {
    expect(isSafeCommand('git status')).toBe(true);
    expect(isSafeCommand('git diff --stat')).toBe(true);
    expect(isSafeCommand('git log --oneline -5')).toBe(true);
    expect(isSafeCommand('git show HEAD')).toBe(true);
    expect(isSafeCommand('git branch')).toBe(true);
    expect(isSafeCommand('git branch -a')).toBe(true);
  });

  it('allows npm test and the lint/typecheck scripts', () => {
    expect(isSafeCommand('npm test')).toBe(true);
    expect(isSafeCommand('npm run lint')).toBe(true);
    expect(isSafeCommand('npm run typecheck')).toBe(true);
  });

  it('allows node --version', () => {
    expect(isSafeCommand('node --version')).toBe(true);
    expect(isSafeCommand('node -v')).toBe(true);
  });

  it('allows read-only process and network inspection', () => {
    expect(isSafeCommand('ps aux')).toBe(true);
    expect(isSafeCommand('ps -ef')).toBe(true);
    expect(isSafeCommand('lsof -nP -iTCP:3000')).toBe(true);
    expect(isSafeCommand('lsof -i :8080')).toBe(true);
    expect(isSafeCommand('lsappinfo list')).toBe(true);
    expect(isSafeCommand('netstat -an')).toBe(true);
    expect(isSafeCommand('netstat -tulpn | grep 3000')).toBe(true);
    expect(isSafeCommand('ps aux | grep node')).toBe(true);
  });

  it('rejects process control commands', () => {
    expect(isSafeCommand('kill 1234')).toBe(false);
    expect(isSafeCommand('pkill node')).toBe(false);
    expect(isSafeCommand('lsof -iTCP:3000 | xargs kill')).toBe(false);
  });

  it('rejects destructive commands', () => {
    expect(isSafeCommand('rm -rf build')).toBe(false);
    expect(isSafeCommand('sudo ls')).toBe(false);
    expect(isSafeCommand('ls; rm -rf /')).toBe(false);
    expect(isSafeCommand('git branch -D main')).toBe(false);
  });

  it('rejects redirects and command substitution', () => {
    expect(isSafeCommand('cat file > out.txt')).toBe(false);
    expect(isSafeCommand('cat file >> out.txt')).toBe(false);
    expect(isSafeCommand('cat < file')).toBe(false);
    expect(isSafeCommand('echo $(whoami)')).toBe(false);
    expect(isSafeCommand('echo `whoami`')).toBe(false);
  });

  it('rejects pipes into shells and non-allowlisted programs', () => {
    expect(isSafeCommand('cat file | sh')).toBe(false);
    expect(isSafeCommand('cat file | bash -s')).toBe(false);
    expect(isSafeCommand('curl https://example.com')).toBe(false);
    expect(isSafeCommand('npm run build')).toBe(false);
    expect(isSafeCommand('git push')).toBe(false);
    expect(isSafeCommand('find . -exec rm {} \\;')).toBe(false);
  });

  it('rejects empty and malformed commands', () => {
    expect(isSafeCommand('')).toBe(false);
    expect(isSafeCommand('   ')).toBe(false);
    expect(isSafeCommand('ls &&')).toBe(false);
    expect(isSafeCommand('| ls')).toBe(false);
  });
});
