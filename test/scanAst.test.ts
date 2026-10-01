import { afterAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { scanTextWithAst } from '../src/scan/engine';
import { RULE_PACKS } from '../src/scan/rules';
import { TreeSitterService } from '../src/scan/treeSitter';

const service = new TreeSitterService({ extensionUri: { fsPath: path.join(__dirname, '..') } });
const options = { includeHotspots: true };

afterAll(() => service.dispose());

async function astIds(text: string, languageId: string): Promise<string[]> {
  const tree = await service.parse(text, languageId);
  const findings = await scanTextWithAst(text, languageId, RULE_PACKS, options, tree);
  return findings.map((finding) => finding.rule.id).filter((id) => id.startsWith('ast-'));
}

describe('ast structural rules', () => {
  it('flags a nested ternary in javascript', async () => {
    const ids = await astIds('const value = a ? b ? c : d : e;\n', 'javascript');
    expect(ids).toContain('ast-nested-ternary');
  });

  it('flags a collapsible if in javascript', async () => {
    const source = ['if (a) {', '  if (b) {', '    work();', '  }', '}', ''].join('\n');
    const ids = await astIds(source, 'javascript');
    expect(ids).toContain('ast-collapsible-if');
  });

  it('flags string concatenation inside a loop in javascript', async () => {
    const source = [
      "let output = '';",
      'for (const item of items) {',
      '  output += item + "!";',
      '}',
      '',
    ].join('\n');
    const ids = await astIds(source, 'javascript');
    expect(ids).toContain('ast-string-concat-in-loop');
  });

  it('flags an infinite loop in javascript', async () => {
    const source = ['while (true) {', '  work();', '}', ''].join('\n');
    const ids = await astIds(source, 'javascript');
    expect(ids).toContain('ast-infinite-loop');
  });

  it('flags unreachable code in python', async () => {
    const source = ['def run(value):', '    return value', '    value = 1', ''].join('\n');
    const ids = await astIds(source, 'python');
    expect(ids).toContain('ast-unreachable-code');
  });

  it('flags a duplicate case in python', async () => {
    const source = [
      'match value:',
      '    case 1:',
      '        first()',
      '    case 1:',
      '        second()',
      '',
    ].join('\n');
    const ids = await astIds(source, 'python');
    expect(ids).toContain('ast-duplicate-case');
  });

  it('flags switch fallthrough in java', async () => {
    const source = [
      'class Demo {',
      '  void run(int value) {',
      '    switch (value) {',
      '      case 1:',
      '        first();',
      '      case 2:',
      '        second();',
      '        break;',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    const ids = await astIds(source, 'java');
    expect(ids).toContain('ast-switch-fallthrough');
  });

  it('flags identical if and else branches in java', async () => {
    const source = [
      'class Demo {',
      '  void run(int value) {',
      '    if (value > 0) {',
      '      work();',
      '    } else {',
      '      work();',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    const ids = await astIds(source, 'java');
    expect(ids).toContain('ast-identical-if-else');
  });

  it('flags unreachable code in go', async () => {
    const source = [
      'package main',
      '',
      'func run() int {',
      '  return 1',
      '  println("dead")',
      '}',
      '',
    ].join('\n');
    const ids = await astIds(source, 'go');
    expect(ids).toContain('ast-unreachable-code');
  });

  it('flags a nested ternary in php', async () => {
    const source = ['<?php', '$value = $a ? $b : ($c ? $d : $e);', ''].join('\n');
    const ids = await astIds(source, 'php');
    expect(ids).toContain('ast-nested-ternary');
  });

  it('flags a duplicate case in javascript', async () => {
    const source = [
      'switch (value) {',
      '  case 1:',
      '    first();',
      '    break;',
      '  case 1:',
      '    second();',
      '    break;',
      '}',
      '',
    ].join('\n');
    const ids = await astIds(source, 'javascript');
    expect(ids).toContain('ast-duplicate-case');
  });

  it('flags a constant condition in javascript', async () => {
    const source = ['if (x && false) {', '  dead();', '}', ''].join('\n');
    const ids = await astIds(source, 'javascript');
    expect(ids).toContain('ast-unreachable-branch');
  });

  it('flags a duplicated condition in javascript', async () => {
    const source = ['if (a) {', '  first();', '} else if (a) {', '  second();', '}', ''].join('\n');
    const ids = await astIds(source, 'javascript');
    expect(ids).toContain('ast-duplicated-condition');
  });

  it('flags an instantiable utility class in javascript', async () => {
    const source = ['class Utils {', '  static run() {}', '  constructor() {}', '}', ''].join('\n');
    const ids = await astIds(source, 'javascript');
    expect(ids).toContain('ast-utility-class-constructor');
  });

  it('flags string concatenation inside a loop in php', async () => {
    const source = [
      '<?php',
      'function run($items) {',
      "  $output = '';",
      '  foreach ($items as $item) {',
      "    $output .= $item . '!';",
      '  }',
      '  return $output;',
      '}',
      '',
    ].join('\n');
    const ids = await astIds(source, 'php');
    expect(ids).toContain('ast-string-concat-in-loop');
  });

  it('flags string concatenation inside a loop in go', async () => {
    const source = [
      'package main',
      '',
      'func run(items []string) string {',
      '  output := ""',
      '  for _, item := range items {',
      '    output += item + "!"',
      '  }',
      '  return output',
      '}',
      '',
    ].join('\n');
    const ids = await astIds(source, 'go');
    expect(ids).toContain('ast-string-concat-in-loop');
  });
});

describe('ast structural rule edge cases', () => {
  it('does not flag an infinite loop that can break out', async () => {
    const source = ['while (true) {', '  if (done) {', '    break;', '  }', '  work();', '}', ''].join('\n');
    expect(await astIds(source, 'javascript')).not.toContain('ast-infinite-loop');
  });

  it('does not flag string concatenation outside a loop', async () => {
    const source = ['let text = "";', 'text += "suffix";', ''].join('\n');
    expect(await astIds(source, 'javascript')).not.toContain('ast-string-concat-in-loop');
  });

  it('does not flag a hoisted function declaration after a return', async () => {
    const source = ['function run() {', '  return 1;', '  function inner() {}', '}', ''].join('\n');
    expect(await astIds(source, 'javascript')).not.toContain('ast-unreachable-code');
  });

  it('does not flag go switch cases without an explicit break', async () => {
    const source = [
      'package main',
      '',
      'func run(value int) {',
      '  switch value {',
      '  case 1:',
      '    first()',
      '  case 2:',
      '    second()',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(await astIds(source, 'go')).not.toContain('ast-switch-fallthrough');
  });
});

describe('ast structural rule negatives', () => {
  it('accepts clean javascript', async () => {
    const source = ['function run(value) {', '  if (value) {', '    return 1;', '  }', '  return 2;', '}', ''].join(
      '\n',
    );
    expect(await astIds(source, 'javascript')).toEqual([]);
  });

  it('accepts clean python', async () => {
    const source = ['def run(value):', '    if value:', '        return 1', '    return 2', ''].join('\n');
    expect(await astIds(source, 'python')).toEqual([]);
  });

  it('accepts clean java', async () => {
    const source = [
      'class Demo {',
      '  void run(int value) {',
      '    if (value > 0) {',
      '      work();',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(await astIds(source, 'java')).toEqual([]);
  });

  it('accepts clean go', async () => {
    const source = [
      'package main',
      '',
      'func run(value int) int {',
      '  if value > 0 {',
      '    return value',
      '  }',
      '  return 0',
      '}',
      '',
    ].join('\n');
    expect(await astIds(source, 'go')).toEqual([]);
  });

  it('accepts clean php', async () => {
    const source = [
      '<?php',
      'function run($value) {',
      '  if ($value) {',
      '    return 1;',
      '  }',
      '  return 2;',
      '}',
      '',
    ].join('\n');
    expect(await astIds(source, 'php')).toEqual([]);
  });
});

describe('scan fallbacks', () => {
  it('still runs regex rules when no tree is available', async () => {
    const findings = await scanTextWithAst(
      'const password = "hunter2hunter2";\n',
      'plaintext',
      RULE_PACKS,
      options,
    );
    expect(findings.map((finding) => finding.rule.id)).toContain('scan-any-generic-secret');
  });

  it('has no grammar for unsupported languages', async () => {
    expect(await service.parse('module Demo where', 'haskell')).toBeUndefined();
  });
});
