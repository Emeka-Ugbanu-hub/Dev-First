import { useEffect, useState } from 'react';
import type { Phase, Plan, TodoItem } from '../../../src/shared/protocol';
import { planToText } from '../../../src/planner/planParser';
import { post } from '../vscode';
import { Markdown, InlineMarkdown } from '../lib/markdown';
import { MermaidDiagram } from './MermaidDiagram';
import { Collapsible } from './Collapsible';

interface Section {
  key: string;
  label: string;
  content: string;
}

export function PlanCard({
  plan,
  phase,
  todos = [],
  onApprove,
}: {
  plan: Plan;
  phase: Phase;
  todos?: TodoItem[];
  onApprove: () => void;
}) {
  const completed = plan.status === 'completed';
  const approved = plan.status === 'approved' || completed;
  const [collapsed, setCollapsed] = useState(approved);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [risksOpen, setRisksOpen] = useState(false);

  useEffect(() => {
    if (phase === 'executing') {
      setCollapsed(false);
    } else if (approved) {
      setCollapsed(true);
    }
  }, [approved, phase, plan.version]);

  if (plan.intent === 'explanation') {
    return null;
  }

  const sections: Section[] = [];
  if (plan.what) {
    sections.push({ key: 'what', label: 'WHAT', content: plan.what });
  }
  if (plan.how) {
    sections.push({ key: 'how', label: 'HOW IT WILL WORK', content: plan.how });
  }
  if (plan.why) {
    sections.push({ key: 'why', label: 'WHY THIS DESIGN', content: plan.why });
  }
  if (plan.tradeoff) {
    sections.push({ key: 'tradeoff', label: 'TRADEOFF', content: plan.tradeoff });
  }

  const planning = phase === 'planning';
  const skippedCount = plan.skippedSteps?.length ?? 0;
  const stepCount = plan.steps?.length ?? 0;
  const activeStepCount = stepCount - skippedCount;
  const liveTasks: TodoItem[] = todos.length > 0
    ? todos
    : (plan.steps ?? []).map((text, index) => ({
      text,
      status: (plan.skippedSteps?.includes(index) ? 'done' : 'pending') as TodoItem['status'],
    }));
  const completedTasks = todos.filter((todo) => todo.status === 'done').length;

  const renderSection = (section: Section) => (
    <div className="plan-section" key={section.key}>
      <div className="plan-section-label">
        {section.label}
        <button
          className="section-explain"
          title={`Explain ${section.label} in more depth`}
          onClick={() => post({ type: 'explainSection', key: section.key })}
        >
          <span className="codicon codicon-book" />
        </button>
      </div>
      <div className="plan-section-content">
        <Markdown text={section.content} />
      </div>
      {section.key === 'how' && plan.flow && <MermaidDiagram source={plan.flow} />}
    </div>
  );

  return (
    <div className={`plan-card anim-fade-slide ${approved ? 'approved' : 'draft'}`}>
      <button className="plan-header" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
        <span className={`plan-chevron codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
        <span className="plan-badge">PLAN</span>
        <span className="plan-title">{plan.title ?? 'Plan'}</span>
        <span className="spacer" />
        {liveTasks.length > 0 && <span className="plan-progress-count">{todos.length > 0 ? `${completedTasks}/${liveTasks.length}` : liveTasks.length} Todo</span>}
        {skippedCount > 0 && <span className="plan-skip-count">{skippedCount} skipped</span>}
        {plan.version > 1 && <span className="plan-version">v{plan.version}</span>}
        {approved && (
          <span className="plan-approved">
            <span className="codicon codicon-check" /> {completed ? 'completed' : 'approved'}
          </span>
        )}
      </button>

      <Collapsible open={!collapsed}>
        <div className="plan-body">
          {editing ? (
            <div className="plan-editor">
              <textarea
                className="edit-textarea plan-editor-text"
                value={draft}
                rows={14}
                spellCheck={false}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="edit-actions">
                <button
                  className="btn-primary"
                  onClick={() => {
                    post({ type: 'updatePlan', markdown: draft });
                    setEditing(false);
                  }}
                >
                  Save plan
                </button>
                <button className="btn-secondary" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {plan.concept && (
                <div className="plan-concept">
                  <span className="codicon codicon-lightbulb" />
                  <span>
                    <InlineMarkdown text={plan.concept} />
                  </span>
                </div>
              )}

              {plan.convention && (
                <div className="plan-convention">
                  <span className="codicon codicon-checklist" />
                  <span>
                    <InlineMarkdown text={plan.convention} />
                  </span>
                </div>
              )}

              {sections.filter((section) => section.key !== 'tradeoff').map(renderSection)}

              {plan.context && plan.context.length > 0 && (
                <div className="plan-section">
                  <div className="plan-section-label">EVIDENCE CHECKED</div>
                  <ul className="plan-context">
                    {plan.context.map((entry, index) => (
                      <li key={index}>
                        <button
                          className="plan-context-link"
                          title={`Open ${entry.path}${entry.startLine ? ` at line ${entry.startLine}` : ''}`}
                          onClick={() => post({ type: 'openFile', path: `${entry.path}${entry.startLine ? `:${entry.startLine}` : ''}` })}
                        >
                          <span className="codicon codicon-go-to-file" /> {entry.path}
                          {entry.startLine && `:${entry.startLine}${entry.endLine && entry.endLine !== entry.startLine ? `-${entry.endLine}` : ''}`}
                        </button>
                        <span className="plan-context-role"> — {entry.role}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {sections.filter((section) => section.key === 'tradeoff').map(renderSection)}

              {plan.risks && plan.risks.length > 0 && (
                <div className="plan-section plan-risks">
                  <button
                    className="plan-risks-header"
                    aria-expanded={risksOpen}
                    onClick={() => setRisksOpen((value) => !value)}
                  >
                    <span className={`codicon codicon-chevron-${risksOpen ? 'down' : 'right'}`} />
                    What could go wrong
                  </button>
                  <Collapsible open={risksOpen}>
                    <ul className="plan-risks-list">
                      {plan.risks.map((risk, index) => (
                        <li key={index}>
                          <InlineMarkdown text={risk} />
                        </li>
                      ))}
                    </ul>
                  </Collapsible>
                </div>
              )}

              {plan.whyNot && (
                <div className="plan-why-not">
                  <span className="codicon codicon-git-compare" />
                  <span>
                    <InlineMarkdown text={`Why not the alternative: ${plan.whyNot}`} />
                  </span>
                </div>
              )}

              {plan.leaveAsIs && (
                <div className="plan-leave-as-is">
                  <span className="codicon codicon-info" />
                  <span>
                    <InlineMarkdown text={`Recommendation: leave as-is — ${plan.leaveAsIs}`} />
                  </span>
                </div>
              )}

              {liveTasks.length > 0 && (
                <section className="plan-todo-section" aria-label="Plan tasks">
                  <div className="plan-todo-heading">
                    <span>{todos.length > 0 ? `${completedTasks}/${liveTasks.length}` : liveTasks.length}</span>
                    <span>Todo</span>
                    {phase === 'executing' && <span className="plan-todo-running">In progress</span>}
                  </div>
                  <ul className="plan-todo-list">
                    {liveTasks.map((todo, index) => {
                      const skipped = todos.length === 0 && (plan.skippedSteps?.includes(index) ?? false);
                      const content = (
                        <>
                          <span className={`todo-icon codicon codicon-${todo.status === 'done' ? 'circle-filled' : todo.status === 'in_progress' ? 'sync' : 'circle-outline'}`} aria-hidden="true" />
                          <span className="todo-text"><InlineMarkdown text={todo.text} /></span>
                          {todo.checkpointId && <span className="todo-revert-icon codicon codicon-history" aria-hidden="true" />}
                        </>
                      );
                      return (
                        <li key={`${index}-${todo.text}`} className={`todo-item todo-${todo.status} ${skipped ? 'todo-skipped' : ''}`}>
                          {todo.checkpointId ? (
                            <button className="todo-row todo-clickable" title="Revert the workspace to before this step" onClick={() => post({ type: 'revertToCheckpoint', checkpointId: todo.checkpointId! })}>
                              {content}
                            </button>
                          ) : !approved && todos.length === 0 ? (
                            <label className="todo-row plan-todo-toggle">
                              <input type="checkbox" className="step-check" checked={!skipped} title={skipped ? 'Include this step' : 'Skip this step'} aria-label={`${skipped ? 'Include' : 'Skip'} step ${index + 1}`} onChange={() => post({ type: 'toggleStep', index })} />
                              {content}
                            </label>
                          ) : (
                            <div className="todo-row">{content}</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          )}

          {!approved && !editing && (
            <button className="go-on" onClick={onApprove} disabled={planning}>
              {planning ? (
                'Updating…'
              ) : (
                <>
                  <span className="codicon codicon-play" /> GO ON
                  {stepCount > 0 && skippedCount > 0 ? ` (${activeStepCount} of ${stepCount} steps)` : ''}
                </>
              )}
            </button>
          )}

          {!editing && (
            <div className="plan-actions">
              <button
                className="plan-action"
                title="Edit the plan text directly"
                onClick={() => {
                  setDraft(planToText(plan));
                  setEditing(true);
                }}
              >
                <span className="codicon codicon-edit" /> Edit plan
              </button>
              {!approved && (
                <button
                  className="plan-action"
                  title="Discard plan"
                  onClick={() => post({ type: 'discardPlan' })}
                >
                  <span className="codicon codicon-trash" /> Discard plan
                </button>
              )}
              {plan.filePath && (
                <button className="plan-action" title="Open the saved plan file" onClick={() => post({ type: 'openPlan' })}>
                  <span className="codicon codicon-go-to-file" /> Open file
                </button>
              )}
              <button
                className="plan-action"
                title="Find learning resources for this task"
                onClick={() => window.dispatchEvent(new Event('df-learn-more'))}
              >
                <span className="codicon codicon-book" /> Learn more
              </button>
            </div>
          )}
        </div>
      </Collapsible>
    </div>
  );
}
