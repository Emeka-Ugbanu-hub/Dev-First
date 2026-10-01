import { post } from '../vscode';

export function SuggestionBar({
  suggestion,
  onDismiss,
}: {
  suggestion: { text: string; command: string };
  onDismiss: () => void;
}) {
  return (
    <div className="suggestion-bar anim-slide-in">
      <span className="codicon codicon-lightbulb" />
      <span className="suggestion-text">{suggestion.text}</span>
      <span className="spacer" />
      <button
        className="btn-small"
        onClick={() => {
          post({ type: 'sendMessage', text: suggestion.command });
          onDismiss();
        }}
      >
        Run {suggestion.command}
      </button>
      <button className="icon-btn" title="Dismiss" onClick={onDismiss}>
        <span className="codicon codicon-close" />
      </button>
    </div>
  );
}
