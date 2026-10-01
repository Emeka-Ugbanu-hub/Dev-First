export function TranscriptSearch({
  query,
  caseSensitive,
  useRegex,
  count,
  current,
  onQueryChange,
  onCaseChange,
  onRegexChange,
  onPrev,
  onNext,
  onClose,
}: {
  query: string;
  caseSensitive: boolean;
  useRegex: boolean;
  count: number;
  current: number;
  onQueryChange: (value: string) => void;
  onCaseChange: (value: boolean) => void;
  onRegexChange: (value: boolean) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  return (
    <div className="transcript-search">
      <input
        className="onboarding-input"
        placeholder="Search this session…"
        value={query}
        autoFocus
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.shiftKey ? onPrev() : onNext();
          }
          if (event.key === 'Escape') {
            onClose();
          }
        }}
      />
      <button
        className={`icon-btn ${caseSensitive ? 'active' : ''}`}
        title="Match case"
        onClick={() => onCaseChange(!caseSensitive)}
      >
        Aa
      </button>
      <button
        className={`icon-btn ${useRegex ? 'active' : ''}`}
        title="Use regular expression"
        onClick={() => onRegexChange(!useRegex)}
      >
        .*
      </button>
      <span className="search-count">{query ? `${count === 0 ? 0 : current + 1}/${count}` : ''}</span>
      <button className="icon-btn" title="Previous match" disabled={count === 0} onClick={onPrev}>
        <span className="codicon codicon-arrow-up" />
      </button>
      <button className="icon-btn" title="Next match" disabled={count === 0} onClick={onNext}>
        <span className="codicon codicon-arrow-down" />
      </button>
      <button className="icon-btn" title="Close search" onClick={onClose}>
        <span className="codicon codicon-close" />
      </button>
    </div>
  );
}
