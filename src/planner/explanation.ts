import { Plan } from '../shared/protocol';

export function isExplanationPlan(plan: Plan): boolean {
  return plan.intent === 'explanation' || !plan.steps?.length;
}

export function explanationToMarkdown(plan: Plan): string {
  const sections: string[] = [];
  if (plan.what) {
    sections.push(`## WHAT\n\n${plan.what}`);
  }
  if (plan.how) {
    sections.push(`## HOW\n\n${plan.how}`);
  }
  if (plan.flow) {
    sections.push(`\`\`\`mermaid\n${plan.flow}\n\`\`\``);
  }
  if (plan.why) {
    sections.push(`## WHY\n\n${plan.why}`);
  }
  if (plan.tradeoff) {
    sections.push(`## TRADEOFF\n\n${plan.tradeoff}`);
  }
  if (plan.context?.length) {
    const files = plan.context.map((entry) => `- \`${entry.path}\` — ${entry.role}`).join('\n');
    sections.push(`## KEY FILES\n\n${files}`);
  }
  return sections.join('\n\n');
}
