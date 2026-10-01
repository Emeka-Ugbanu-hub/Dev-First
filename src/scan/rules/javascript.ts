import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from '../languages/profiles';
import type { RulePack, ScanRange } from '../ruleTypes';
import { nodeRange } from '../treeSitter';
import { descendantsOf, named } from './analyzerUtils';

function floatingPromise(tree: Tree, profile: LanguageProfile): ScanRange[] {
  const asyncNames = new Set<string>();
  for (const fn of descendantsOf(tree.rootNode, ['function_declaration', 'generator_function_declaration'])) {
    if (fn.children.some((child) => child?.type === 'async')) {
      const name = fn.childForFieldName('name');
      if (name) {
        asyncNames.add(name.text);
      }
    }
  }
  for (const declarator of descendantsOf(tree.rootNode, ['variable_declarator'])) {
    const name = declarator.childForFieldName('name');
    const value = declarator.childForFieldName('value');
    if (name?.type === 'identifier' && value && isAsyncFunction(value)) {
      asyncNames.add(name.text);
    }
  }
  const out: ScanRange[] = [];
  for (const statement of descendantsOf(tree.rootNode, ['expression_statement'])) {
    const expression = named(statement, profile)[0];
    if (expression?.type === 'call_expression' && isPromiseCall(expression, asyncNames)) {
      out.push(nodeRange(statement));
    }
  }
  return out;
}

function isAsyncFunction(node: Node): boolean {
  if (node.type !== 'arrow_function' && node.type !== 'function_expression') {
    return false;
  }
  return node.children.some((child) => child?.type === 'async');
}

function isPromiseCall(call: Node, asyncNames: Set<string>): boolean {
  const callee = call.childForFieldName('function');
  if (!callee) {
    return false;
  }
  if (callee.type === 'identifier') {
    return callee.text === 'fetch' || asyncNames.has(callee.text);
  }
  if (callee.type !== 'member_expression') {
    return false;
  }
  const object = callee.childForFieldName('object');
  const property = callee.childForFieldName('property');
  if (property?.text === 'then') {
    return true;
  }
  if (property?.text === 'catch' || property?.text === 'finally') {
    return false;
  }
  if (property && asyncNames.has(property.text)) {
    return true;
  }
  return object?.type === 'identifier' && object.text === 'axios';
}

export const javascriptPack: RulePack = {
  id: 'javascript',
  languages: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
  rules: [
    {
      id: 'scan-js-loose-equality',
      category: 'bug',
      severity: 'warning',
      pattern: /(?<![=!])[=!]=(?!=)/,
      message: 'Loose equality can coerce types unexpectedly.',
      why: 'The == and != operators convert operands, so values like "0" and false can compare equal.',
      fix: 'Use === or !== unless the coercion is intentional and documented.',
    },
    {
      id: 'scan-js-eval',
      category: 'vulnerability',
      severity: 'error',
      pattern: /\beval\s*\(/,
      message: 'eval() executes arbitrary code.',
      why: 'Input that reaches eval can run attacker-controlled code in your process.',
      fix: 'Parse the data or use a safe interpreter/switch instead of evaluating strings.',
    },
    {
      id: 'scan-js-new-function',
      category: 'vulnerability',
      severity: 'error',
      pattern: /\bnew\s+Function\s*\(/,
      message: 'new Function() compiles strings into code.',
      why: 'Like eval, it turns strings into executable JavaScript and is easy to inject into.',
      fix: 'Replace dynamic code generation with a lookup table or explicit functions.',
    },
    {
      id: 'scan-js-inner-html',
      category: 'vulnerability',
      severity: 'warning',
      pattern: /\.(?:innerHTML|outerHTML)\s*=/,
      message: 'Assigning innerHTML/outerHTML can introduce XSS.',
      why: 'The assigned string is parsed as HTML, so untrusted values can inject scripts or event handlers.',
      fix: 'Use textContent or build DOM nodes; sanitize with a vetted library when HTML is required.',
    },
    {
      id: 'scan-js-document-write',
      category: 'vulnerability',
      severity: 'warning',
      pattern: /\bdocument\.write\s*\(/,
      message: 'document.write() can inject markup.',
      why: 'It writes raw HTML into the document and can be abused for cross-site scripting.',
      fix: 'Create elements with the DOM API or set textContent instead.',
    },
    {
      id: 'scan-js-dangerous-html',
      category: 'vulnerability',
      severity: 'warning',
      pattern: /dangerouslySetInnerHTML/,
      message: 'dangerouslySetInnerHTML bypasses React escaping.',
      why: 'The injected HTML is not sanitized, so untrusted content can execute scripts.',
      fix: 'Sanitize the HTML with a library like DOMPurify or render text content instead.',
    },
    {
      id: 'scan-js-child-process',
      category: 'vulnerability',
      severity: 'error',
      pattern: /\b(?:exec|execSync)\s*\(\s*(?:['"`][^\n]*\$\{|[^)\n]*\+)/,
      message: 'Shell command built from a template or concatenation.',
      why: 'Interpolated values can inject shell metacharacters and run arbitrary commands.',
      fix: 'Use execFile/spawn with an argument array, or validate and escape every interpolated value.',
    },
    {
      id: 'scan-js-weak-hash',
      category: 'vulnerability',
      severity: 'warning',
      pattern: /createHash\s*\(\s*['"](?:md5|MD5|sha1|SHA1)['"]/,
      message: 'MD5/SHA-1 are weak for security use.',
      why: 'Both algorithms have practical collision attacks and should not protect passwords or signatures.',
      fix: 'Use SHA-256 or better, and a slow password hash such as bcrypt, scrypt, or argon2.',
    },
    {
      id: 'scan-js-math-random',
      category: 'hotspot',
      severity: 'info',
      pattern: /\bMath\.random\s*\(/,
      message: 'Math.random() is not cryptographically secure.',
      why: 'Its output is predictable, which matters for tokens, IDs, and security decisions.',
      fix: 'Use crypto.randomUUID() or crypto.getRandomValues() for anything security-related.',
    },
    {
      id: 'scan-js-tls-disabled',
      category: 'vulnerability',
      severity: 'error',
      pattern: /rejectUnauthorized\s*:\s*false/,
      message: 'TLS certificate validation is disabled.',
      why: 'Disabling validation allows man-in-the-middle attacks against the connection.',
      fix: 'Remove the option and trust the correct CA instead of skipping verification.',
    },
    {
      id: 'scan-js-tls-env-disabled',
      category: 'vulnerability',
      severity: 'error',
      pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]/,
      message: 'TLS verification disabled process-wide.',
      why: 'NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks for every request in the process.',
      fix: 'Remove the override and configure the proper certificate authorities.',
    },
    {
      id: 'scan-js-jwt-decode',
      category: 'vulnerability',
      severity: 'warning',
      pattern: /\bjwt\.decode\s*\(/,
      message: 'jwt.decode() does not verify the signature.',
      why: 'Decoding trusts attacker-supplied claims without checking that the token was signed by you.',
      fix: 'Use jwt.verify() with the expected algorithm and secret or public key.',
    },
    {
      id: 'scan-js-cors-wildcard',
      category: 'vulnerability',
      severity: 'warning',
      pattern: /\borigin\s*:\s*(?:['"]\*['"]|true)/,
      message: 'Permissive CORS origin.',
      why: 'Reflecting any origin lets other sites read authenticated responses from your API.',
      fix: 'Restrict origin to an explicit allowlist of trusted hosts.',
    },
    {
      id: 'scan-js-empty-catch',
      category: 'bug',
      severity: 'warning',
      pattern: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/,
      message: 'Empty catch block swallows errors.',
      why: 'Failures disappear silently, making production issues hard to diagnose.',
      fix: 'Handle the error, log it with context, or rethrow it.',
    },
    {
      id: 'scan-js-parseint',
      category: 'bug',
      severity: 'info',
      pattern: /\bparseInt\s*\([^,)]+\)/,
      message: 'parseInt() called without a radix.',
      why: 'Without a radix the result can depend on legacy prefix parsing (e.g. leading zero).',
      fix: 'Pass an explicit base, usually parseInt(value, 10).',
    },
    {
      id: 'scan-js-sort',
      category: 'bug',
      severity: 'info',
      pattern: /\.sort\s*\(\s*\)/,
      message: 'sort() without a comparator compares as strings.',
      why: 'The default comparator stringifies elements, so [1, 10, 2] sorts as [1, 10, 2].',
      fix: 'Pass a comparator such as (a, b) => a - b for numbers.',
    },
    {
      id: 'scan-js-console-log',
      category: 'smell',
      severity: 'info',
      pattern: /\bconsole\.log\s*\(/,
      message: 'console.log left in code.',
      why: 'Debug logging clutters output and can leak data in production builds.',
      fix: 'Remove the call or route it through a logger with levels.',
    },
    {
      id: 'scan-self-assignment',
      category: 'bug',
      severity: 'warning',
      pattern: /(?<![.\w])(\w+)\s*=\s*\1\s*;/,
      message: 'Variable assigned to itself.',
      why: 'The assignment leaves the value unchanged and usually means the target or the right-hand side was mistyped.',
      fix: 'Assign the intended expression or remove the statement.',
    },
    {
      id: 'scan-identical-operands',
      category: 'bug',
      severity: 'warning',
      pattern: /(\w+)\s*(?:===|!==|==|!=|&&|\|\|)\s*\1\b/,
      message: 'Operator has identical operands.',
      why: 'Comparing or combining a value with itself is always true or always false, so the check is dead.',
      fix: 'Use the intended second operand or remove the redundant condition.',
    },
    {
      id: 'scan-js-sql-injection',
      category: 'vulnerability',
      severity: 'error',
      pattern: /\b(?:query|execute|raw)\s*\(\s*(?:[`'"][^`'"]*\$\{|[`'"][^`'"]*['"`]\s*\+)/,
      message: 'SQL statement built with interpolation or concatenation.',
      why: 'Embedding values directly in the query text lets user input change the statement and enables SQL injection.',
      fix: 'Use parameter placeholders and pass the values separately, or use the query builder of your ORM.',
    },
    {
      id: 'scan-nosql-injection',
      category: 'vulnerability',
      severity: 'warning',
      pattern: /\$where\s*:|\b(?:find|findOne|updateOne|deleteOne)\s*\(\s*req\./,
      message: 'MongoDB query built from request input.',
      why: 'Passing request data straight into a query lets operators like $where or $ne change its meaning.',
      fix: 'Validate and cast each field, reject object values, and never expose query operators to clients.',
    },
    {
      id: 'scan-path-traversal',
      category: 'vulnerability',
      severity: 'warning',
      pattern: /\b(?:readFile|readFileSync|sendFile|createReadStream|unlink|writeFile)\s*\([^)\n]*req\.(?:query|params|body)\b/,
      message: 'File path taken from request input.',
      why: 'A path built from user input can contain ../ segments and read or overwrite files outside the intended directory.',
      fix: 'Resolve the path against a fixed root and reject any value that escapes it.',
    },
    {
      id: 'scan-regexp-exec-misuse',
      category: 'bug',
      severity: 'info',
      pattern: /\.exec\s*\(/,
      message: 'RegExp.exec() call.',
      why: 'exec depends on the global flag and lastIndex state, which is easy to misuse across calls.',
      fix: 'Prefer match or test, or reset lastIndex when reusing a global regex.',
    },
    {
      id: 'scan-js-return-boolean',
      category: 'smell',
      severity: 'info',
      pattern: /\breturn\s+(?:true|false)\s*;/,
      message: 'Boolean literal returned directly.',
      why: 'Returning true or false from a branch is usually a redundant if that can be expressed as one expression.',
      fix: 'Return the condition itself, e.g. return value > 0.',
    },
    {
      kind: 'analyzer',
      id: 'js-floating-promise',
      category: 'bug',
      severity: 'warning',
      languages: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
      run: floatingPromise,
      message: 'Promise result is ignored.',
      why: 'An unawaited async call runs in the background, so failures become unhandled rejections and ordering breaks.',
      fix: 'Await the call, return it, mark it with void, or attach a .catch() handler.',
    },
  ],
};
