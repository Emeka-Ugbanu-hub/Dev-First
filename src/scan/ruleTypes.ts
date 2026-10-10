import type { Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from './languages/profiles';

export type ScanCategory =
  | 'bug'
  | 'vulnerability'
  | 'smell'
  | 'hotspot'
  | 'secret'
  | 'architecture'
  | 'maintainability'
  | 'scalability';
export type ScanSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface ScanRange {
  line: number;
  startChar: number;
  endChar: number;
}

interface BaseScanRule {
  id: string;
  category: ScanCategory;
  severity: ScanSeverity;
  languages?: string[];
  message: string;
  why: string;
  fix: string;
  concept?: string;
  confidence?: 'high' | 'medium' | 'low';
  evidence?: Array<{ path: string; line: number }>;
}

export interface RegexScanRule extends BaseScanRule {
  kind?: 'regex';
  pattern: RegExp;
  fileLevel?: boolean;
}

export interface AstScanRule extends BaseScanRule {
  kind: 'ast';
  query: (profile: LanguageProfile) => string;
  capture?: string;
}

export interface AnalyzerScanRule extends BaseScanRule {
  kind: 'analyzer';
  run: (tree: Tree, profile: LanguageProfile, text: string) => ScanRange[];
}

export type ScanRule = RegexScanRule | AstScanRule | AnalyzerScanRule;

export interface RulePack {
  id: string;
  languages?: string[];
  rules: ScanRule[];
}

export interface ScanFinding {
  rule: ScanRule;
  line: number;
  startChar: number;
  endChar: number;
}

export function isRegexRule(rule: ScanRule): rule is RegexScanRule {
  return rule.kind === undefined || rule.kind === 'regex';
}
