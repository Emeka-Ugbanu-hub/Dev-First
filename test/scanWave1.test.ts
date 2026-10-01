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

describe('self assignment', () => {
  it('flags a variable assigned to itself', async () => {
    expect(await ids(lines('let x = 1;', 'x = x;'), 'javascript')).toContain('scan-self-assignment');
  });

  it('does not flag a normal assignment', async () => {
    expect(await ids(lines('let x = 1;', 'x = y;'), 'javascript')).not.toContain('scan-self-assignment');
  });
});

describe('assignment in condition', () => {
  it('flags a single equals inside an if', async () => {
    expect(await ids(lines('if (x = 1) {', '  work();', '}'), 'javascript')).toContain(
      'scan-assignment-in-condition',
    );
  });

  it('does not flag strict equality or arrow functions', async () => {
    const source = lines('if (x === 1) {', '  work();', '}', 'if (items.map((x) => x.id)) {', '  work();', '}');
    expect(await ids(source, 'javascript')).not.toContain('scan-assignment-in-condition');
  });
});

describe('identical operands', () => {
  it('flags a value compared with itself', async () => {
    expect(await ids(lines('if (a == a) {', '  work();', '}'), 'javascript')).toContain(
      'scan-identical-operands',
    );
  });

  it('does not flag different operands', async () => {
    expect(await ids(lines('if (a == b) {', '  work();', '}'), 'javascript')).not.toContain(
      'scan-identical-operands',
    );
  });
});

describe('java string equality', () => {
  it('flags == against a string literal', async () => {
    const source = lines(
      'class Demo {',
      '  boolean isAdmin(String name) {',
      '    return name == "admin";',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('scan-java-equals-strings');
  });

  it('does not flag equals()', async () => {
    const source = lines(
      'class Demo {',
      '  boolean isAdmin(String name) {',
      '    return name.equals("admin");',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('scan-java-equals-strings');
  });
});

describe('java optional get', () => {
  it('flags get() without a presence check', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    Optional<String> value = find();',
      '    value.get();',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).toContain('scan-java-optional-get');
  });

  it('does not flag get() guarded by isPresent()', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    Optional<String> value = find();',
      '    if (value.isPresent()) {',
      '      value.get();',
      '    }',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('scan-java-optional-get');
  });
});

describe('unused import', () => {
  it('flags an imported binding that is never used', async () => {
    const source = lines("import { unusedThing } from './mod';", 'const value = 1;');
    expect(await ids(source, 'javascript')).toContain('scan-unused-import');
  });

  it('does not flag a used import', async () => {
    const source = lines("import { usedThing } from './mod';", 'console.log(usedThing);');
    expect(await ids(source, 'javascript')).not.toContain('scan-unused-import');
  });
});

describe('duplicated string', () => {
  it('flags the second and third occurrences', async () => {
    const source = lines(
      'const a = "duplicate-value";',
      'const b = "duplicate-value";',
      'const c = "duplicate-value";',
    );
    const found = await ids(source, 'javascript');
    expect(found.filter((id) => id === 'scan-duplicated-string')).toHaveLength(2);
  });

  it('does not flag two occurrences', async () => {
    const source = lines('const a = "duplicate-value";', 'const b = "duplicate-value";');
    expect(await ids(source, 'javascript')).not.toContain('scan-duplicated-string');
  });
});

describe('unreleased lock', () => {
  it('flags a lock without a finally unlock', async () => {
    const source = lines('class Demo {', '  void run() {', '    lock.lock();', '    work();', '  }', '}');
    expect(await ids(source, 'java')).toContain('scan-lock-unreleased');
  });

  it('does not flag a lock released in finally', async () => {
    const source = lines(
      'class Demo {',
      '  void run() {',
      '    lock.lock();',
      '    try {',
      '      work();',
      '    } finally {',
      '      lock.unlock();',
      '    }',
      '  }',
      '}',
    );
    expect(await ids(source, 'java')).not.toContain('scan-lock-unreleased');
  });
});

describe('javascript sql injection', () => {
  it('flags a query built from a template literal', async () => {
    const source = lines('function load(db, id) {', '  db.query(`SELECT * FROM users WHERE id = ${id}`);', '}');
    expect(await ids(source, 'javascript')).toContain('scan-js-sql-injection');
  });

  it('does not flag a parameterized query', async () => {
    const source = lines('function load(db, id) {', '  db.query("SELECT * FROM users WHERE id = ?", [id]);', '}');
    expect(await ids(source, 'javascript')).not.toContain('scan-js-sql-injection');
  });
});

describe('path traversal', () => {
  it('flags a file read from request input', async () => {
    const source = lines('function read(req, fs) {', '  fs.readFile(req.query.file, callback);', '}');
    expect(await ids(source, 'javascript')).toContain('scan-path-traversal');
  });

  it('does not flag a fixed path', async () => {
    const source = lines('function read(fs) {', "  fs.readFile('./data.json', callback);", '}');
    expect(await ids(source, 'javascript')).not.toContain('scan-path-traversal');
  });
});

describe('ssrf', () => {
  it('flags a request to a variable target', async () => {
    expect(await ids(lines('function load(target) {', '  fetch(target);', '}'), 'javascript')).toContain(
      'scan-ssrf',
    );
  });

  it('does not flag a literal URL', async () => {
    const source = lines('function load() {', "  fetch('https://api.example.com/data');", '}');
    expect(await ids(source, 'javascript')).not.toContain('scan-ssrf');
  });
});

describe('secrets in logs', () => {
  it('flags a log call that includes a token', async () => {
    expect(await ids(lines("console.log('token', token);"), 'javascript')).toContain('scan-secrets-in-logs');
  });

  it('does not flag a plain log message', async () => {
    expect(await ids(lines("console.log('starting');"), 'javascript')).not.toContain('scan-secrets-in-logs');
  });
});

describe('cookie flags', () => {
  it('flags a cookie without protective flags', async () => {
    expect(await ids(lines("res.cookie('sid', token);"), 'javascript')).toContain('scan-cookie-flags');
  });

  it('does not flag a cookie with secure and httpOnly', async () => {
    const source = lines("res.cookie('sid', token, { httpOnly: true, secure: true, sameSite: 'lax' });");
    expect(await ids(source, 'javascript')).not.toContain('scan-cookie-flags');
  });
});

describe('csrf disabled', () => {
  it('flags disabled csrf middleware', async () => {
    expect(await ids(lines('app.use(csrf().disable());'), 'javascript')).toContain('scan-csrf-disabled');
  });

  it('does not flag enabled csrf middleware', async () => {
    expect(await ids(lines('app.use(csrf());'), 'javascript')).not.toContain('scan-csrf-disabled');
  });
});

describe('naming class', () => {
  it('flags a lowercase class name', async () => {
    expect(await ids(lines('class demo {}'), 'javascript')).toContain('scan-naming-class');
  });

  it('does not flag a PascalCase class name', async () => {
    expect(await ids(lines('class Demo {}'), 'javascript')).not.toContain('scan-naming-class');
  });
});

describe('naming function', () => {
  it('flags an uppercase javascript function name', async () => {
    expect(await ids(lines('function GetValue() {', '  return 1;', '}'), 'javascript')).toContain(
      'scan-naming-function',
    );
  });

  it('does not flag camelCase functions', async () => {
    expect(await ids(lines('function getValue() {', '  return 1;', '}'), 'javascript')).not.toContain(
      'scan-naming-function',
    );
  });

  it('flags camelCase python defs', async () => {
    expect(await ids(lines('def getValue():', '    return 1'), 'python')).toContain('scan-naming-function');
  });
});

describe('wildcard import', () => {
  it('flags a java wildcard import', async () => {
    expect(await ids(lines('import java.util.*;'), 'java')).toContain('scan-wildcard-import');
  });

  it('does not flag an explicit java import', async () => {
    expect(await ids(lines('import java.util.List;'), 'java')).not.toContain('scan-wildcard-import');
  });
});

describe('magic number', () => {
  it('flags a comparison against a bare literal', async () => {
    expect(await ids(lines('if (count > 3) {', '  work();', '}'), 'javascript')).toContain('scan-magic-number');
  });

  it('does not flag comparisons against 0, 1, or 2', async () => {
    const source = lines('if (count > 0) {', '  work();', '}', 'if (count === 1) {', '  work();', '}');
    expect(await ids(source, 'javascript')).not.toContain('scan-magic-number');
  });
});

describe('deprecated java api', () => {
  it('flags Thread.stop', async () => {
    const source = lines('class Demo {', '  void run() {', '    Thread.stop();', '  }', '}');
    expect(await ids(source, 'java')).toContain('scan-deprecated-api');
  });

  it('does not flag Thread.start', async () => {
    const source = lines('class Demo {', '  void run() {', '    Thread.start();', '  }', '}');
    expect(await ids(source, 'java')).not.toContain('scan-deprecated-api');
  });
});

describe('empty class', () => {
  it('flags an empty javascript class', async () => {
    expect(await ids(lines('class Empty {}'), 'javascript')).toContain('scan-empty-class');
  });

  it('does not flag a class with members', async () => {
    expect(await ids(lines('class Full {', '  run() {}', '}'), 'javascript')).not.toContain('scan-empty-class');
  });
});

describe('html duplicate id', () => {
  it('flags a repeated id', async () => {
    const source = lines('<div id="first"></div>', '<span id="first"></span>');
    expect(await ids(source, 'html')).toContain('scan-html-duplicate-id');
  });

  it('does not flag unique ids', async () => {
    const source = lines('<div id="first"></div>', '<span id="second"></span>');
    expect(await ids(source, 'html')).not.toContain('scan-html-duplicate-id');
  });
});

describe('html table header', () => {
  it('flags a table without header cells', async () => {
    const source = lines('<table>', '  <tr><td>value</td></tr>', '</table>');
    expect(await ids(source, 'html')).toContain('scan-html-table-no-th');
  });

  it('does not flag a table with header cells', async () => {
    const source = lines('<table>', '  <tr><th scope="col">name</th></tr>', '</table>');
    expect(await ids(source, 'html')).not.toContain('scan-html-table-no-th');
  });
});

describe('css duplicate selector', () => {
  it('flags a repeated selector', async () => {
    const source = lines('.card {', '  color: red;', '}', '.card {', '  color: blue;', '}');
    expect(await ids(source, 'css')).toContain('scan-css-duplicate-selector');
  });

  it('does not flag distinct selectors', async () => {
    const source = lines('.card {', '  color: red;', '}', '.panel {', '  color: blue;', '}');
    expect(await ids(source, 'css')).not.toContain('scan-css-duplicate-selector');
  });
});

describe('high entropy secret', () => {
  it('flags a long random literal', async () => {
    const source = lines('const value = "Zx9Qw2Er5Ty8Ui1Op3As6Df4";');
    expect(await ids(source, 'javascript')).toContain('scan-secrets-high-entropy');
  });

  it('does not flag a hex hash or a sentence', async () => {
    const source = lines(
      'const hash = "abcdef0123456789abcdef0123456789";',
      'const message = "a long but ordinary sentence";',
    );
    expect(await ids(source, 'javascript')).not.toContain('scan-secrets-high-entropy');
  });
});

describe('mailgun token', () => {
  it('flags a mailgun key', async () => {
    const source = lines('const value = "key-3ax6xnjp29jd6fds4gc373sgvjxteol0";');
    expect(await ids(source, 'javascript')).toContain('scan-secrets-mailgun');
  });

  it('does not flag a short key prefix', async () => {
    expect(await ids(lines('const value = "key-abc";'), 'javascript')).not.toContain('scan-secrets-mailgun');
  });
});

describe('reflection hotspot', () => {
  it('flags Class.forName', async () => {
    const source = lines('class Demo {', '  void run() {', '    Class.forName("com.example.Demo");', '  }', '}');
    expect(await ids(source, 'java')).toContain('scan-hotspot-reflection');
  });

  it('does not flag a plain method call', async () => {
    const source = lines('class Demo {', '  void run() {', '    getName();', '  }', '}');
    expect(await ids(source, 'java')).not.toContain('scan-hotspot-reflection');
  });
});
