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

describe('dead store', () => {
  it('flags an assignment overwritten before it is read', async () => {
    const source = lines('function run() {', '  let value = 1;', '  value = 2;', '  return value;', '}');
    expect(await ids(source, 'javascript')).toContain('an-dead-store');
  });

  it('does not flag a value read before reassignment', async () => {
    const source = lines(
      'function run() {',
      '  let value = 1;',
      '  use(value);',
      '  value = 2;',
      '  return value;',
      '}',
    );
    expect(await ids(source, 'javascript')).not.toContain('an-dead-store');
  });

  it('does not flag a value used inside a branch', async () => {
    const source = lines(
      'function run(flag) {',
      '  let value = 1;',
      '  if (flag) {',
      '    use(value);',
      '  }',
      '  value = 2;',
      '  return value;',
      '}',
    );
    expect(await ids(source, 'javascript')).not.toContain('an-dead-store');
  });

  it('flags a value that is never used at the end of a function', async () => {
    const source = lines('function run() {', '  const unused = compute();', '}');
    expect(await ids(source, 'javascript')).toContain('an-dead-store');
  });

  it('does not flag an assignment carried across a loop', async () => {
    const source = lines('function run(cond) {', '  let value = 0;', '  while (cond) {', '    value = 1;', '  }', '}');
    expect(await ids(source, 'javascript')).not.toContain('an-dead-store');
  });

  it('does not flag a value captured by a closure', async () => {
    const source = lines('function run() {', '  let value = 1;', '  return () => value;', '}');
    expect(await ids(source, 'javascript')).not.toContain('an-dead-store');
  });

  it('honors devfirst-ignore suppression', async () => {
    const source = lines(
      'def run():',
      '    value = 1  # devfirst-ignore an-dead-store',
      '    value = 2',
      '    return value',
    );
    expect(await ids(source, 'python')).not.toContain('an-dead-store');
  });
});

describe('infinite recursion', () => {
  it('flags an unconditional self call', async () => {
    const source = lines('function recurse() {', '  return recurse();', '}');
    expect(await ids(source, 'javascript')).toContain('an-infinite-recursion');
  });

  it('does not flag a guarded self call', async () => {
    const source = lines(
      'function recurse(n) {',
      '  if (n <= 0) {',
      '    return 0;',
      '  }',
      '  return recurse(n - 1);',
      '}',
    );
    expect(await ids(source, 'javascript')).not.toContain('an-infinite-recursion');
  });

  it('does not flag a call to another function', async () => {
    const source = lines('function first() {', '  return second();', '}');
    expect(await ids(source, 'javascript')).not.toContain('an-infinite-recursion');
  });

  it('flags an unconditional python self call', async () => {
    const source = lines('def recurse():', '    return recurse()');
    expect(await ids(source, 'python')).toContain('an-infinite-recursion');
  });
});

describe('literal index out of bounds', () => {
  it('flags a constant index past the array literal length', async () => {
    const source = lines('const value = [1, 2, 3][5];');
    expect(await ids(source, 'javascript')).toContain('an-literal-index-out-of-bounds');
  });

  it('does not flag an in-range constant index', async () => {
    const source = lines('const value = [1, 2, 3][2];');
    expect(await ids(source, 'javascript')).not.toContain('an-literal-index-out-of-bounds');
  });

  it('does not flag a variable index', async () => {
    const source = lines('const index = 5;', 'const value = [1, 2, 3][index];');
    expect(await ids(source, 'javascript')).not.toContain('an-literal-index-out-of-bounds');
  });

  it('flags a python tuple index past the end', async () => {
    const source = lines('value = (1, 2)[5]');
    expect(await ids(source, 'python')).toContain('an-literal-index-out-of-bounds');
  });

  it('flags a java array literal index past the end', async () => {
    const source = lines('class Demo {', '  void run() {', '    int value = new int[]{1, 2}[3];', '  }', '}');
    expect(await ids(source, 'java')).toContain('an-literal-index-out-of-bounds');
  });

  it('flags a go slice literal index past the end', async () => {
    const source = lines('package main', '', 'func main() {', '  value := []int{1, 2, 3}[5]', '  _ = value', '}');
    expect(await ids(source, 'go')).toContain('an-literal-index-out-of-bounds');
  });
});

describe('collection modified during iteration', () => {
  it('flags a splice on the iterated collection', async () => {
    const source = lines(
      'function run(list) {',
      '  for (const item of list) {',
      '    list.splice(0, 1);',
      '  }',
      '}',
    );
    expect(await ids(source, 'javascript')).toContain('an-collection-modified-during-iteration');
  });

  it('does not flag a mutation of a different collection', async () => {
    const source = lines('def run(items, other):', '    for item in items:', '        other.remove(item)');
    expect(await ids(source, 'python')).not.toContain('an-collection-modified-during-iteration');
  });

  it('flags a python remove on the iterated collection', async () => {
    const source = lines('def run(items):', '    for item in items:', '        items.remove(item)');
    expect(await ids(source, 'python')).toContain('an-collection-modified-during-iteration');
  });
});

describe('resource leak', () => {
  it('flags a java stream that is never closed', async () => {
    const source = lines(
      'class Demo {',
      '  void run() throws Exception {',
      '    FileInputStream in = new FileInputStream("data.txt");',
      '    in.read();',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('an-resource-leak');
  });

  it('does not flag try-with-resources', async () => {
    const source = lines(
      'class Demo {',
      '  void run() throws Exception {',
      '    try (FileInputStream in = new FileInputStream("data.txt")) {',
      '      in.read();',
      '    }',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('an-resource-leak');
  });

  it('does not flag a go file closed with defer', async () => {
    const source = lines(
      'package main',
      '',
      'func main() {',
      '  file, err := os.Open("data.txt")',
      '  if err != nil {',
      '    return',
      '  }',
      '  defer file.Close()',
      '}',
    );
    expect(await ids(source, 'go')).not.toContain('an-resource-leak');
  });

  it('flags a go file that is never closed', async () => {
    const source = lines('package main', '', 'func main() {', '  file, err := os.Open("data.txt")', '  _ = err', '  _ = file', '}');
    expect(await ids(source, 'go')).toContain('an-resource-leak');
  });

  it('flags a javascript file handle that is never closed', async () => {
    const source = lines('function run() {', "  const fd = fs.openSync('data.txt');", '}');
    expect(await ids(source, 'javascript')).toContain('an-resource-leak');
  });
});

describe('class coupling', () => {
  it('flags a class referencing more than twenty types', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    A a = new A(); B b = new B(); C c = new C(); D d = new D(); E e = new E();',
      '    F f = new F(); G g = new G(); H h = new H(); I i = new I(); J j = new J();',
      '    K k = new K(); L l = new L(); M m = new M(); N n = new N(); O o = new O();',
      '    P p = new P(); Q q = new Q(); R r = new R(); S s = new S(); T t = new T();',
      '    U u = new U();',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('an-class-coupling');
  });

  it('does not flag a class with few references', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    Helper.help();',
      '    Service service = new Service();',
      '    service.call();',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('an-class-coupling');
  });
});

describe('null dereference', () => {
  it('flags a member access on a variable assigned null', async () => {
    const source = lines('function run() {', '  let value = null;', '  value.foo();', '}');
    expect(await ids(source, 'javascript')).toContain('an-null-deref');
  });

  it('does not flag a guarded null access', async () => {
    const source = lines(
      'function run() {',
      '  let value = null;',
      '  if (value != null) {',
      '    value.foo();',
      '  }',
      '}',
    );
    expect(await ids(source, 'javascript')).not.toContain('an-null-deref');
  });

  it('flags a python attribute access on None', async () => {
    const source = lines('def run():', '    value = None', '    value.foo()');
    expect(await ids(source, 'python')).toContain('an-null-deref');
  });
});

describe('use before definition', () => {
  it('flags a read before a let declaration', async () => {
    const source = lines('function run() {', '  console.log(value);', '  let value = 1;', '}');
    expect(await ids(source, 'javascript')).toContain('an-use-before-definition');
  });

  it('does not flag a read after the declaration', async () => {
    const source = lines('function run() {', '  let value = 1;', '  console.log(value);', '}');
    expect(await ids(source, 'javascript')).not.toContain('an-use-before-definition');
  });

  it('does not flag a hoisted function call', async () => {
    const source = lines('function run() {', '  helper();', '  function helper() {}', '}');
    expect(await ids(source, 'javascript')).not.toContain('an-use-before-definition');
  });

  it('flags a python read before assignment', async () => {
    const source = lines('def run():', '    print(value)', '    value = 1');
    expect(await ids(source, 'python')).toContain('an-use-before-definition');
  });
});

describe('integer overflow literal', () => {
  it('flags overflowing java integer literals', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    int bad = 100000 * 100000;',
      '    int abs = Math.abs(Integer.MIN_VALUE);',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('an-integer-overflow-literal');
  });

  it('does not flag a product that fits', async () => {
    const source = lines('class Demo {', '  void run() {', '    int ok = 1000 * 1000;', '  }', '}');
    expect(await ids(source, 'java')).not.toContain('an-integer-overflow-literal');
  });

  it('flags a go constant product past the int64 range', async () => {
    const source = lines(
      'package main',
      '',
      'func main() {',
      '  var value int64 = 10000000000 * 10000000000',
      '  _ = value',
      '}',
    );
    expect(await ids(source, 'go')).toContain('an-integer-overflow-literal');
  });

  it('does not flag a go constant product that fits', async () => {
    const source = lines(
      'package main',
      '',
      'func main() {',
      '  var value int64 = 1000000 * 1000000',
      '  _ = value',
      '}',
    );
    expect(await ids(source, 'go')).not.toContain('an-integer-overflow-literal');
  });
});
