export function StatusRow({
  text,
  tone,
}: {
  text: string;
  tone: 'progress' | 'error';
}) {
  return (
    <div className={`status-row status-${tone}`} role="status" aria-live="polite">
      <span
        className={`codicon ${tone === 'error' ? 'codicon-error' : 'codicon-loading codicon-modifier-spin'}`}
        aria-hidden="true"
      />
      <span className="status-text">{text}</span>
    </div>
  );
}
