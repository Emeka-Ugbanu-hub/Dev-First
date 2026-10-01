import type { Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from '../languages/profiles';
import type { RulePack, ScanRange } from '../ruleTypes';

const HIGH_ENTROPY_LIMIT = 3;

function rangeAt(text: string, start: number, end: number): ScanRange {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < start; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  const lineEnd = text.indexOf('\n', start);
  const capped = lineEnd === -1 ? end : Math.min(end, lineEnd);
  return { line, startChar: start - lineStart, endChar: capped - lineStart };
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function isBenignString(value: string): boolean {
  if (/^https?:\/\//i.test(value)) {
    return true;
  }
  if (value.includes('/') || value.includes('\\')) {
    return true;
  }
  if (/^[0-9a-fA-F]+$/.test(value)) {
    return true;
  }
  return /\s/.test(value);
}

function highEntropyString(_tree: Tree, _profile: LanguageProfile, text: string): ScanRange[] {
  const out: ScanRange[] = [];
  const pattern = /(['"])([^'"\n]{20,})\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && out.length < HIGH_ENTROPY_LIMIT) {
    const value = match[2];
    if (isBenignString(value) || entropy(value) <= 4.5) {
      continue;
    }
    out.push(rangeAt(text, match.index, match.index + match[0].length));
  }
  return out;
}

export const secretsMorePack: RulePack = {
  id: 'secrets-more',
  rules: [
    {
      id: 'scan-secrets-mailgun',
      category: 'secret',
      severity: 'error',
      pattern: /\bkey-[0-9a-zA-Z]{32}\b/,
      message: 'Possible Mailgun API key.',
      why: 'A Mailgun key can send mail as your domain and read sending statistics.',
      fix: 'Revoke the key in the Mailgun dashboard and load the replacement from a secret store.',
    },
    {
      id: 'scan-secrets-heroku',
      category: 'secret',
      severity: 'error',
      pattern: /\bheroku[a-zA-Z0-9_-]{32,}/,
      message: 'Possible Heroku API key.',
      why: 'A Heroku API key can manage apps, config vars, and add-ons for the account.',
      fix: 'Revoke the key in the Heroku account settings and inject the new key from a secret store.',
    },
    {
      id: 'scan-secrets-shopify',
      category: 'secret',
      severity: 'error',
      pattern: /\bshpat_[0-9a-fA-F]{32}\b/,
      message: 'Possible Shopify access token.',
      why: 'A Shopify access token can read and modify store data through the Admin API.',
      fix: 'Uninstall or rotate the app credential in Shopify and keep the token outside the repository.',
    },
    {
      id: 'scan-secrets-square',
      category: 'secret',
      severity: 'error',
      pattern: /\bsq0atp-[0-9A-Za-z_-]{22}\b/,
      message: 'Possible Square access token.',
      why: 'A Square access token can read payments and customer data and create charges.',
      fix: 'Revoke the token in the Square developer dashboard and rotate the affected credentials.',
    },
    {
      id: 'scan-secrets-cloudflare',
      category: 'secret',
      severity: 'error',
      pattern:
        /\bv1\.0-[A-Za-z0-9_-]{40,}\b|[Cc]loudflare[^\n]{0,40}(?:[Aa]pi|[Kk]ey)[^\n]{0,20}['"][A-Za-z0-9_-]{20,}['"]/,
      message: 'Possible Cloudflare API token.',
      why: 'A Cloudflare API token can change DNS, firewall rules, and other account resources.',
      fix: 'Roll the token in the Cloudflare dashboard and store it in a secret manager.',
    },
    {
      kind: 'analyzer',
      id: 'scan-secrets-high-entropy',
      category: 'secret',
      severity: 'error',
      run: highEntropyString,
      message: 'High-entropy string that may be a secret.',
      why: 'Long random-looking literals are usually keys or tokens, and committed secrets survive in git history.',
      fix: 'Confirm whether the value is a secret, rotate it, and move it to configuration or a secret store.',
    },
  ],
};
