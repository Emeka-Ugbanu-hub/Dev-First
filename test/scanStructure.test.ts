import { afterAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { scanTextWithAst } from '../src/scan/engine';
import { RULE_PACKS } from '../src/scan/rules';
import { TreeSitterService } from '../src/scan/treeSitter';

const service = new TreeSitterService({ extensionUri: { fsPath: path.join(__dirname, '..') } });
const options = { includeHotspots: true };

afterAll(() => service.dispose());

async function ids(text: string, languageId: string): Promise<string[]> {
  const tree = await service.parse(text, languageId);
  const findings = await scanTextWithAst(text, languageId, RULE_PACKS, options, tree);
  return findings.map((finding) => finding.rule.id);
}

function lines(...rows: string[]): string {
  return `${rows.join('\n')}\n`;
}

function javaClassWithMethods(count: number): string {
  const source = ['class Demo {'];
  for (let i = 0; i < count; i++) {
    source.push(`  void m${i}() { work(); }`);
  }
  source.push('}', '');
  return source.join('\n');
}

function javaClassWithCases(count: number): string {
  const source = ['class Demo {', '  void run(int x) {', '    switch (x) {'];
  for (let i = 0; i < count; i++) {
    source.push(`      case ${i}: work(); break;`);
  }
  source.push('    }', '  }', '}', '');
  return source.join('\n');
}

describe('structure rules', () => {
  it('flags a class with more than 20 methods', async () => {
    expect(await ids(javaClassWithMethods(21), 'java')).toContain('an-too-many-methods');
  });

  it('does not flag a class with 20 methods', async () => {
    expect(await ids(javaClassWithMethods(20), 'java')).not.toContain('an-too-many-methods');
  });

  it('flags a class with more than 15 fields', async () => {
    const source = ['class Demo {'];
    for (let i = 0; i < 16; i++) {
      source.push(`  f${i}: number = 0;`);
    }
    source.push('}', '');
    expect(await ids(source.join('\n'), 'typescript')).toContain('an-too-many-fields');
  });

  it('does not flag a class with 15 fields', async () => {
    const source = ['class Demo {'];
    for (let i = 0; i < 15; i++) {
      source.push(`  f${i}: number = 0;`);
    }
    source.push('}', '');
    expect(await ids(source.join('\n'), 'typescript')).not.toContain('an-too-many-fields');
  });

  it('flags a function with two boolean parameters', async () => {
    const source = lines(
      'class Demo {',
      '  void run(boolean a, boolean b) {',
      '    work();',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('an-boolean-params');
  });

  it('does not flag a function with a single boolean parameter', async () => {
    const source = lines(
      'class Demo {',
      '  void run(boolean a) {',
      '    work();',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('an-boolean-params');
  });

  it('flags a function with more than four break or continue statements', async () => {
    const source = lines(
      'function run(x) {',
      '  while (x) { break; }',
      '  while (x) { break; }',
      '  while (x) { continue; }',
      '  while (x) { break; }',
      '  while (x) { continue; }',
      '}',
    );
    expect(await ids(source, 'javascript')).toContain('an-too-many-breaks');
  });

  it('does not flag a function with four break or continue statements', async () => {
    const source = lines(
      'function run(x) {',
      '  while (x) { break; }',
      '  while (x) { break; }',
      '  while (x) { continue; }',
      '  while (x) { break; }',
      '}',
    );
    expect(await ids(source, 'javascript')).not.toContain('an-too-many-breaks');
  });

  it('flags a switch with more than 15 cases', async () => {
    expect(await ids(javaClassWithCases(16), 'java')).toContain('an-oversized-switch');
  });

  it('does not flag a switch with 15 cases', async () => {
    expect(await ids(javaClassWithCases(15), 'java')).not.toContain('an-oversized-switch');
  });

  it('flags private members that are never used', async () => {
    const source = lines(
      'class Demo {',
      '  private int count;',
      '  private void helper() {',
      '    work();',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('an-unused-private-member');
  });

  it('does not flag a private member that is referenced', async () => {
    const source = lines(
      'class Demo {',
      '  private int count;',
      '  int size() {',
      '    return count;',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('an-unused-private-member');
  });

  it('does not flag a private member mentioned in a string', async () => {
    const source = lines(
      'class Demo {',
      '  private int count;',
      '  String label = "count";',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('an-unused-private-member');
  });

  it('flags a method with an empty body', async () => {
    const source = lines('class Demo {', '  run() {}', '}');
    expect(await ids(source, 'javascript')).toContain('an-empty-method');
  });

  it('does not flag a method with a body', async () => {
    const source = lines('class Demo {', '  run() {', '    work();', '  }', '}');
    expect(await ids(source, 'javascript')).not.toContain('an-empty-method');
  });

  it('flags a python method whose body is only pass', async () => {
    const source = lines('class Demo:', '    def run(self):', '        pass');
    expect(await ids(source, 'python')).toContain('an-empty-method');
  });

  it('flags a parenthesized negation condition', async () => {
    const source = lines('if (!(value)) {', '  work();', '}');
    expect(await ids(source, 'javascript')).toContain('an-negated-condition');
  });

  it('does not flag a plain negation condition', async () => {
    const source = lines('if (!value) {', '  work();', '}');
    expect(await ids(source, 'javascript')).not.toContain('an-negated-condition');
  });

  it('flags unsorted imports', async () => {
    const source = lines('import z', 'import a');
    expect(await ids(source, 'python')).toContain('an-import-ordering');
  });

  it('does not flag sorted imports', async () => {
    const source = lines('import a', 'import z');
    expect(await ids(source, 'python')).not.toContain('an-import-ordering');
  });

  it('flags a field declared after a method', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    work();',
      '  }',
      '  private int count;',
      '}',
    );
    expect(await ids(source, 'java')).toContain('an-member-ordering');
  });

  it('does not flag fields, constructors, and methods in order', async () => {
    const source = lines(
      'class Demo {',
      '  private int count;',
      '  Demo() {',
      '    work();',
      '  }',
      '  void run() {',
      '    work();',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('an-member-ordering');
  });

  it('honors devfirst-ignore suppression for an empty method', async () => {
    const source = lines(
      'class Demo {',
      '  // devfirst-ignore an-empty-method',
      '  run() {}',
      '}',
    );
    expect(await ids(source, 'javascript')).not.toContain('an-empty-method');
  });
});
