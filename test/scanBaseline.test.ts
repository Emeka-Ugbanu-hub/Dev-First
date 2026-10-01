import { describe, expect, it } from 'vitest';
import { findingKey, ScanBaseline } from '../src/scan/baseline';

class FakeMemento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

describe('findingKey', () => {
  it('does not depend on the line number', () => {
    const line = 'const password = "hunter2hunter2";';
    expect(findingKey('scan-any-generic-secret', 'src/auth.ts', line)).toBe(
      findingKey('scan-any-generic-secret', 'src/auth.ts', line),
    );
  });

  it('ignores leading and trailing whitespace on the line', () => {
    expect(findingKey('r', 'src/a.ts', '    if (a == b) {  ')).toBe(
      findingKey('r', 'src/a.ts', 'if (a == b) {'),
    );
  });

  it('changes when the line text changes', () => {
    expect(findingKey('r', 'src/a.ts', 'const x = 1;')).not.toBe(
      findingKey('r', 'src/a.ts', 'const x = 2;'),
    );
  });

  it('includes the rule id and relative path', () => {
    expect(findingKey('one', 'src/a.ts', 'line')).not.toBe(findingKey('two', 'src/a.ts', 'line'));
    expect(findingKey('one', 'src/a.ts', 'line')).not.toBe(findingKey('one', 'src/b.ts', 'line'));
  });
});

describe('ScanBaseline', () => {
  it('matches a finding after it shifts lines', () => {
    const baseline = new ScanBaseline(new FakeMemento() as never);
    baseline.record([findingKey('r', 'src/a.ts', 'if (a == b) {')]);
    expect(baseline.has(findingKey('r', 'src/a.ts', 'if (a == b) {'))).toBe(true);
    expect(baseline.has(findingKey('r', 'src/a.ts', 'if (a != b) {'))).toBe(false);
  });

  it('persists recorded keys and reloads them', () => {
    const memento = new FakeMemento();
    const baseline = new ScanBaseline(memento as never);
    baseline.record([findingKey('r', 'src/a.ts', 'line')]);
    baseline.dispose();
    const reloaded = new ScanBaseline(memento as never);
    expect(reloaded.has(findingKey('r', 'src/a.ts', 'line'))).toBe(true);
  });

  it('clears recorded keys', async () => {
    const memento = new FakeMemento();
    const baseline = new ScanBaseline(memento as never);
    baseline.record([findingKey('r', 'src/a.ts', 'line')]);
    await baseline.clear();
    expect(baseline.size).toBe(0);
    expect(baseline.has(findingKey('r', 'src/a.ts', 'line'))).toBe(false);
  });
});
