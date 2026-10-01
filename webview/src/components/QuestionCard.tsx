import { useMemo, useState } from 'react';
import type { QuestionItem, QuestionRequest } from '../../../src/shared/protocol';
import { post } from '../vscode';

export function formatBatchAnswer(questions: QuestionItem[], answers: string[]): string {
  return questions
    .map((question, index) => `${question.question}: ${answers[index]?.trim() || '(skipped)'}`)
    .join('\n');
}

export function QuestionCard({ request }: { request: QuestionRequest }) {
  const questions = useMemo(
    () => (request.questions && request.questions.length > 0 ? request.questions : undefined),
    [request.questions],
  );
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const [customActive, setCustomActive] = useState(false);

  const currentItem = questions ? questions[Math.min(index, questions.length - 1)] : undefined;
  const current = currentItem ?? request;
  const multiple = Boolean(current.multiple);
  const allowCustom = currentItem ? currentItem.custom !== false : true;
  const total = questions?.length ?? 1;
  const isLast = !questions || index >= questions.length - 1;

  const reset = () => {
    setSelected([]);
    setCustom('');
    setCustomActive(false);
  };

  const answerText = [...selected, custom.trim()].filter(Boolean).join(', ');

  const toggle = (label: string) => {
    setCustomActive(false);
    setCustom('');
    setSelected((previous) => {
      if (multiple) {
        return previous.includes(label)
          ? previous.filter((item) => item !== label)
          : [...previous, label];
      }
      return previous.includes(label) ? [] : [label];
    });
  };

  const advance = (answer: string) => {
    if (!questions) {
      if (answer) {
        post({ type: 'questionAnswer', id: request.id, answer });
      }
      return;
    }
    const next = [...answers];
    next[index] = answer;
    if (index < questions.length - 1) {
      setAnswers(next);
      setIndex(index + 1);
      reset();
      return;
    }
    post({ type: 'questionAnswer', id: request.id, answer: formatBatchAnswer(questions, next) });
  };

  const submit = () => {
    if (!questions && !answerText) {
      return;
    }
    advance(answerText);
  };

  const skip = () => {
    if (questions) {
      advance('');
      return;
    }
    post({ type: 'questionAnswer', id: request.id, answer: '' });
  };

  const headerLabel = questions
    ? `${questions[index]?.header ?? request.header ?? 'Questions'}${total > 1 ? ` (${index + 1}/${total})` : ''}`
    : request.header ?? 'Questions';

  return (
    <div className="question-card">
      <div className="question-header">
        <span className="question-header-icon"><span className="codicon codicon-question" /></span>
        <span>{headerLabel}</span>
      </div>
      <div className="question-text">{current.question}</div>
      {current.options.length > 0 && (
        <div className="question-options">
          {current.options.map((option, optionIndex) => {
            const active = selected.includes(option.label);
            return (
              <button
                key={option.label}
                className={`question-option ${active ? 'selected' : ''}`}
                onClick={() => toggle(option.label)}
              >
                <span className="question-option-key">{String.fromCharCode(65 + optionIndex)}</span>
                <span className="question-option-label">{option.label}</span>
                {option.description && <span className="question-option-desc">{option.description}</span>}
              </button>
            );
          })}
          {allowCustom && (
            <button
              type="button"
              className={`question-option question-custom-option ${customActive ? 'selected' : ''}`}
              onClick={() => {
                setCustomActive(true);
                setSelected([]);
              }}
            >
              <span className="question-option-key">{String.fromCharCode(65 + current.options.length)}</span>
              {customActive ? (
                <input
                  autoFocus
                  className="question-custom-input"
                  placeholder="Type your answer…"
                  value={custom}
                  onChange={(event) => setCustom(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <span className="question-custom-placeholder">Something else...</span>
              )}
            </button>
          )}
        </div>
      )}
      {current.options.length === 0 && allowCustom && (
        <textarea
          className="question-freeform"
          placeholder="Type your answer…"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }}
        />
      )}
      <div className="question-footer">
        <span className="question-footer-hint">{multiple ? 'Select all that apply' : ''}</span>
        <div className="question-footer-actions">
          {questions && index > 0 && (
            <button
              type="button"
              className="question-skip"
              onClick={() => {
                setIndex(index - 1);
                reset();
              }}
            >Back</button>
          )}
          <button type="button" className="question-skip" onClick={skip}>Skip</button>
          <button className="question-continue" disabled={!answerText} onClick={submit}>
            {questions && !isLast ? 'Next' : 'Continue'} <span aria-hidden="true">↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
