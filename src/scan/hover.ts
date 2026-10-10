import * as vscode from 'vscode';
import type { ScanRunner } from './scanner';
import type { ScanCategory } from './ruleTypes';

const CATEGORY_ICONS: Record<ScanCategory, string> = {
  bug: 'bug',
  vulnerability: 'shield',
  smell: 'warning',
  hotspot: 'flame',
  secret: 'key',
  architecture: 'layers',
  maintainability: 'tools',
  scalability: 'graph-line',
};

export function createHoverProvider(runner: ScanRunner): vscode.HoverProvider {
  return {
    provideHover(document, position) {
      if (document.uri.scheme !== 'file') {
        return undefined;
      }
      const finding = runner.getFindings(document.uri.toString()).find((entry) => {
        if (entry.line !== position.line) {
          return false;
        }
        if (entry.startChar === entry.endChar) {
          return true;
        }
        return position.character >= entry.startChar - 2 && position.character <= entry.endChar + 2;
      });
      if (!finding) {
        return undefined;
      }
      const markdown = new vscode.MarkdownString();
      markdown.supportThemeIcons = true;
      markdown.appendMarkdown(
        `**$(${CATEGORY_ICONS[finding.rule.category]}) ${finding.rule.category} · ${finding.rule.severity} — ${finding.rule.message}**\n\n`,
      );
      markdown.appendMarkdown(`*Why:* ${finding.rule.why}\n\n`);
      markdown.appendMarkdown(`*Fix:* ${finding.rule.fix}\n\n`);
      if (finding.rule.concept) {
        markdown.appendMarkdown(`_Concept: ${finding.rule.concept}_\n\n`);
      }
      if (finding.rule.confidence) {
        markdown.appendMarkdown(`_Confidence: ${finding.rule.confidence}_\n\n`);
      }
      markdown.appendMarkdown(`_Dev-First · ${finding.rule.category}_`);
      return new vscode.Hover(markdown);
    },
  };
}
