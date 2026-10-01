import { Fragment, useRef } from 'react';
import type { Phase, Plan, TodoItem, UiMessage } from '../../../src/shared/protocol';
import { MessageBubble, isLiveMessage } from './MessageBubble';
import { PlanCard } from './PlanCard';

const EXAMPLES = [
  {
    icon: 'server-process',
    title: 'Add an endpoint',
    prompt: 'Add a health check endpoint that returns the service status and version.',
  },
  {
    icon: 'beaker',
    title: 'Write tests',
    prompt: 'Write tests for the authentication flow.',
  },
  {
    icon: 'symbol-method',
    title: 'Refactor a file',
    prompt: 'Refactor src/index.ts for readability and consistency.',
  },
];

export function ChatView({
  messages,
  onExample,
  mcpDisplay,
  plan,
  todos,
  phase,
  planAnchor,
  onApprove,
  viewableRuns,
}: {
  messages: UiMessage[];
  onExample: (text: string) => void;
  mcpDisplay: 'plain' | 'markdown';
  plan?: Plan | null;
  todos?: TodoItem[];
  phase?: Phase;
  planAnchor?: string | null;
  onApprove?: () => void;
  viewableRuns?: string[];
}) {
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) {
    seen.current = new Set(messages.map((message) => message.id));
  }
  const freshIds = messages.filter((message) => !seen.current!.has(message.id)).map((message) => message.id);
  for (const id of freshIds) {
    seen.current.add(id);
  }

  if (messages.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-title">Plan first, then build.</div>
        <div className="empty-sub">
          Describe what you want. Dev-First turns it into a plan you approve before any code changes.
        </div>
        <div className="example-grid">
          {EXAMPLES.map((example) => (
            <button key={example.title} className="example-card" onClick={() => onExample(example.prompt)}>
              <span className={`codicon codicon-${example.icon}`} />
              <span className="example-title">{example.title}</span>
              <span className="example-prompt">{example.prompt}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  const planCard = plan && phase && onApprove ? { plan, phase, todos, onApprove } : null;
  const anchored = Boolean(planCard && messages.some((message) => message.id === planAnchor));
  return (
    <div className="chat-view">
      {messages.map((message) => (
        <Fragment key={message.id}>
          <div
            className="message-slot"
            data-message-id={message.id}
            data-message-role={message.role}
            data-live={isLiveMessage(message) ? 'true' : undefined}
            data-fresh={freshIds.includes(message.id) ? 'true' : undefined}
          >
            <MessageBubble message={message} mcpDisplay={mcpDisplay} viewableRuns={viewableRuns} />
          </div>
          {planCard && message.id === planAnchor && (
            <PlanCard plan={planCard.plan} phase={planCard.phase} todos={planCard.todos} onApprove={planCard.onApprove} />
          )}
        </Fragment>
      ))}
      {planCard && !anchored && (
        <PlanCard plan={planCard.plan} phase={planCard.phase} todos={planCard.todos} onApprove={planCard.onApprove} />
      )}
    </div>
  );
}
