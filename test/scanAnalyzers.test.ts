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

function nestedIfs(depth: number): string {
  const source = ['function run(a) {'];
  for (let i = 0; i < depth; i++) {
    source.push(`${'  '.repeat(i + 1)}if (a) {`);
  }
  source.push(`${'  '.repeat(depth + 1)}work();`);
  for (let i = depth; i > 0; i--) {
    source.push(`${'  '.repeat(i)}}`);
  }
  source.push('}', '');
  return source.join('\n');
}

describe('analyzer rules', () => {
  it('flags cognitive complexity over the limit', async () => {
    const source = ['function run(x) {'];
    for (let i = 0; i < 16; i++) {
      source.push(`  if (x === ${i}) { work(); }`);
    }
    source.push('}', '');
    expect(await ids(source.join('\n'), 'javascript')).toContain('an-cognitive-complexity');
  });

  it('does not flag moderate cognitive complexity', async () => {
    const source = ['function run(x) {', '  if (x) {', '    if (x > 1) { work(); }', '  }', '}', ''].join('\n');
    expect(await ids(source, 'javascript')).not.toContain('an-cognitive-complexity');
  });

  it('does not leak nested function complexity into the parent', async () => {
    const source = ['function outer() {'];
    source.push('  function inner(x) {');
    for (let i = 0; i < 16; i++) {
      source.push(`    if (x === ${i}) { work(); }`);
    }
    source.push('  }', '  return inner;', '}', '');
    const text = source.join('\n');
    const tree = await service.parse(text, 'javascript');
    const findings = await scanTextWithAst(text, 'javascript', RULE_PACKS, options, tree);
    const hits = findings.filter((finding) => finding.rule.id === 'an-cognitive-complexity');
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  it('flags deep block nesting', async () => {
    expect(await ids(nestedIfs(5), 'javascript')).toContain('an-deep-nesting');
  });

  it('does not flag four levels of nesting', async () => {
    expect(await ids(nestedIfs(4), 'javascript')).not.toContain('an-deep-nesting');
  });

  it('flags a function longer than 80 lines', async () => {
    const source = ['function run() {'];
    for (let i = 0; i < 82; i++) {
      source.push('  work();');
    }
    source.push('}', '');
    expect(await ids(source.join('\n'), 'javascript')).toContain('an-long-function');
  });

  it('does not flag a short function', async () => {
    expect(await ids(lines('function run() {', '  work();', '}'), 'javascript')).not.toContain(
      'an-long-function',
    );
  });

  it('flags more than seven parameters', async () => {
    const source = lines(
      'function run(a, b, c, d, e, f, g, h) {',
      '  return a + b + c + d + e + f + g + h;',
      '}',
    );
    expect(await ids(source, 'javascript')).toContain('an-too-many-params');
  });

  it('does not flag seven parameters', async () => {
    const source = lines(
      'function run(a, b, c, d, e, f, g) {',
      '  return a + b + c + d + e + f + g;',
      '}',
    );
    expect(await ids(source, 'javascript')).not.toContain('an-too-many-params');
  });

  it('flags more than six return statements', async () => {
    const source = ['function run(x) {'];
    for (let i = 0; i < 7; i++) {
      source.push(`  if (x === ${i}) return ${i};`);
    }
    source.push('}', '');
    expect(await ids(source.join('\n'), 'javascript')).toContain('an-too-many-returns');
  });

  it('does not flag a few returns', async () => {
    const source = lines('function run(x) {', '  if (x) return 1;', '  return 2;', '}');
    expect(await ids(source, 'javascript')).not.toContain('an-too-many-returns');
  });

  it('flags an unused local in python', async () => {
    const source = lines('def run():', '    unused = 5', '    return 1');
    expect(await ids(source, 'python')).toContain('an-unused-local');
  });

  it('does not flag a used local in python', async () => {
    const source = lines('def run():', '    used = 5', '    return used');
    expect(await ids(source, 'python')).not.toContain('an-unused-local');
  });

  it('flags an unused parameter in python', async () => {
    const source = lines('def run(value):', '    return 1');
    expect(await ids(source, 'python')).toContain('an-unused-param');
  });

  it('does not flag a used parameter in python', async () => {
    const source = lines('def run(value):', '    return value');
    expect(await ids(source, 'python')).not.toContain('an-unused-param');
  });

  it('does not flag parameters on decorated python functions', async () => {
    const source = lines(
      'class Child(Base):',
      '    @override',
      '    def run(self, value):',
      '        return 1',
    );
    expect(await ids(source, 'python')).not.toContain('an-unused-param');
  });

  it('does not flag parameters on java overrides', async () => {
    const source = lines(
      'class Demo {',
      '  @Override',
      '  public boolean equals(Object other) {',
      '    return other instanceof Demo;',
      '  }',
      '}',
    );
    const found = await ids(source, 'java');
    expect(found).not.toContain('an-unused-param');
  });

  it('flags duplicated function bodies at the second occurrence', async () => {
    const source = lines(
      'function first() {',
      '  a();',
      '  b();',
      '  c();',
      '  d();',
      '  e();',
      '  f();',
      '}',
      'function second() {',
      '  a();',
      '  b();',
      '  c();',
      '  d();',
      '  e();',
      '  f();',
      '}',
    );
    const findings = await ids(source, 'javascript');
    expect(findings).toContain('an-duplicated-block');
  });

  it('does not flag distinct function bodies', async () => {
    const source = lines(
      'function first() {',
      '  a();',
      '  b();',
      '  c();',
      '  d();',
      '  e();',
      '  f();',
      '}',
      'function second() {',
      '  a();',
      '  b();',
      '  c();',
      '  d();',
      '  e();',
      '  f(1);',
      '}',
    );
    expect(await ids(source, 'javascript')).not.toContain('an-duplicated-block');
  });

  it('flags a python format string count mismatch', async () => {
    const source = lines('def run(a):', '    return "{} {}".format(a)');
    expect(await ids(source, 'python')).toContain('an-format-string-mismatch');
  });

  it('flags a python percent format count mismatch', async () => {
    const source = lines('value = "%s %s" % (a,)');
    expect(await ids(source, 'python')).toContain('an-format-string-mismatch');
  });

  it('does not flag matching python format strings', async () => {
    const source = lines('def run(a, b):', '    return "{} {}".format(a, b)');
    expect(await ids(source, 'python')).not.toContain('an-format-string-mismatch');
  });

  it('does not flag reused explicit python format indexes', async () => {
    const source = lines('def run(a):', '    return "{0} {0}".format(a)');
    expect(await ids(source, 'python')).not.toContain('an-format-string-mismatch');
  });

  it('flags a java format string count mismatch', async () => {
    const source = lines(
      'class Demo {',
      '  void run(String input) {',
      '    String.format("%s %d", input);',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('an-format-string-mismatch');
  });

  it('does not flag a matching java format string', async () => {
    const source = lines(
      'class Demo {',
      '  void run(String input) {',
      '    String.format("%s", input);',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('an-format-string-mismatch');
  });

  it('flags a java integer placeholder with a float literal', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    String.format("%d", 1.5);',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('an-format-string-mismatch');
  });

  it('flags a folded numeric condition', async () => {
    const source = lines('if (2 + 2 == 5) {', '  dead();', '}');
    expect(await ids(source, 'javascript')).toContain('an-constant-condition');
  });

  it('flags a folded string comparison in java', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    if ("a" == "a") {',
      '      same();',
      '    }',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('an-constant-condition');
  });

  it('does not fold javascript string equality', async () => {
    const source = lines('if ("a" == "a") {', '  same();', '}');
    expect(await ids(source, 'javascript')).not.toContain('an-constant-condition');
  });

  it('does not flag a normal condition', async () => {
    const source = lines('if (value > 2) {', '  work();', '}');
    expect(await ids(source, 'javascript')).not.toContain('an-constant-condition');
  });

  it('honors devfirst-ignore suppression', async () => {
    const source = lines('def run():', '    unused = 5  # devfirst-ignore an-unused-local', '    return 1');
    expect(await ids(source, 'python')).not.toContain('an-unused-local');
  });
});

describe('java specific rules', () => {
  it('flags equals without hashCode', async () => {
    const source = lines(
      'class Demo {',
      '  public boolean equals(Object other) {',
      '    return other instanceof Demo;',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('java-equals-hashcode');
  });

  it('accepts equals with hashCode', async () => {
    const source = lines(
      'class Demo {',
      '  public boolean equals(Object other) {',
      '    return other instanceof Demo;',
      '  }',
      '  public int hashCode() {',
      '    return 1;',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('java-equals-hashcode');
  });

  it('flags a serializable class without serialVersionUID', async () => {
    const source = lines('class Demo implements Serializable {', '  private int value;', '}');
    expect(await ids(source, 'java')).toContain('java-serialversionuid');
  });

  it('accepts a serializable class with serialVersionUID', async () => {
    const source = lines(
      'class Demo implements Serializable {',
      '  private static final long serialVersionUID = 1L;',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('java-serialversionuid');
  });

  it('flags a static SimpleDateFormat', async () => {
    const source = lines(
      'class Demo {',
      '  private static SimpleDateFormat format = new SimpleDateFormat("yyyy");',
      '}',
    );
    expect(await ids(source, 'java')).toContain('java-shared-dateformat');
  });

  it('accepts an instance SimpleDateFormat', async () => {
    const source = lines(
      'class Demo {',
      '  private SimpleDateFormat format = new SimpleDateFormat("yyyy");',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('java-shared-dateformat');
  });

  it('flags double checked locking', async () => {
    const source = lines(
      'class Demo {',
      '  private Object value;',
      '  void run() {',
      '    if (value == null) {',
      '      synchronized (this) {',
      '        if (value == null) {',
      '          value = new Object();',
      '        }',
      '      }',
      '    }',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('java-double-checked-locking');
  });

  it('accepts a different inner condition', async () => {
    const source = lines(
      'class Demo {',
      '  private Object value;',
      '  void run(boolean ready) {',
      '    if (ready) {',
      '      synchronized (this) {',
      '        if (value == null) {',
      '          value = new Object();',
      '        }',
      '      }',
      '    }',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('java-double-checked-locking');
  });

  it('flags wait outside a synchronized block', async () => {
    const source = lines('class Demo {', '  void run() {', '    wait();', '  }', '}');
    expect(await ids(source, 'java')).toContain('java-wait-notify');
  });

  it('accepts wait inside a synchronized block', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    synchronized (this) {',
      '      wait();',
      '    }',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('java-wait-notify');
  });
});

describe('javascript specific rules', () => {
  it('flags a floating promise', async () => {
    const source = lines('async function load() {', "  fetch('/api');", '}');
    expect(await ids(source, 'javascript')).toContain('js-floating-promise');
  });

  it('flags a floating axios call', async () => {
    const source = lines('function load() {', "  axios.get('/api');", '}');
    expect(await ids(source, 'javascript')).toContain('js-floating-promise');
  });

  it('flags a floating call to an in-file async function', async () => {
    const source = lines('async function load() {', '  return 1;', '}', 'function run() {', '  load();', '}');
    expect(await ids(source, 'javascript')).toContain('js-floating-promise');
  });

  it('accepts awaited, returned, and caught promises', async () => {
    const source = lines(
      'async function load() {',
      "  await fetch('/api');",
      "  return fetch('/other');",
      "  void fetch('/void');",
      "  fetch('/caught').catch(() => {});",
      '}',
    );
    expect(await ids(source, 'javascript')).not.toContain('js-floating-promise');
  });

  it('accepts a synchronous call', async () => {
    const source = lines('function run() {', '  save(item);', '}');
    expect(await ids(source, 'javascript')).not.toContain('js-floating-promise');
  });
});

describe('security specific rules', () => {
  it('flags a nested quantifier regex literal', async () => {
    const source = lines('const pattern = /(a+)+$/;');
    expect(await ids(source, 'javascript')).toContain('redos-nested-quantifier');
  });

  it('accepts a safe regex literal', async () => {
    const source = lines('const pattern = /(ab)+$/;');
    expect(await ids(source, 'javascript')).not.toContain('redos-nested-quantifier');
  });

  it('flags a nested quantifier in python re.compile', async () => {
    const source = lines('import re', 'pattern = re.compile(r"(a+)+$")');
    expect(await ids(source, 'python')).toContain('redos-nested-quantifier');
  });

  it('flags a nested quantifier in java Pattern.compile', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    Pattern.compile("(a+)+$");',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('redos-nested-quantifier');
  });

  it('flags an express redirect from user input', async () => {
    const source = lines('function run(req, res) {', '  res.redirect(req.query.next);', '}');
    expect(await ids(source, 'javascript')).toContain('open-redirect');
  });

  it('accepts a literal express redirect', async () => {
    const source = lines('function run(req, res) {', "  res.redirect('/home');", '}');
    expect(await ids(source, 'javascript')).not.toContain('open-redirect');
  });

  it('flags a flask redirect from user input', async () => {
    const source = lines('def run(request):', "    return redirect(request.args.get('next'))");
    expect(await ids(source, 'python')).toContain('open-redirect');
  });

  it('accepts a literal flask redirect', async () => {
    const source = lines('def run(request):', "    return redirect('/home')");
    expect(await ids(source, 'python')).not.toContain('open-redirect');
  });

  it('flags an insecure express session cookie', async () => {
    const source = lines("app.use(session({ secret: 'x', cookie: { secure: false } }));");
    expect(await ids(source, 'javascript')).toContain('session-fixation');
  });

  it('accepts a secure express session cookie', async () => {
    const source = lines("app.use(session({ secret: 'x', cookie: { secure: true, httpOnly: true } }));");
    expect(await ids(source, 'javascript')).not.toContain('session-fixation');
  });

  it('flags an insecure python session cookie', async () => {
    const source = lines("app.config['SESSION_COOKIE_SECURE'] = False");
    expect(await ids(source, 'python')).toContain('session-fixation');
  });

  it('accepts a secure python session cookie', async () => {
    const source = lines("app.config['SESSION_COOKIE_SECURE'] = True");
    expect(await ids(source, 'python')).not.toContain('session-fixation');
  });
});
