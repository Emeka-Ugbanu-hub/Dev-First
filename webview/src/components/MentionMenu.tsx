import type { SessionSummary } from '../../../src/shared/protocol';
import { filterMentions } from '../lib/mentions';

export function MentionMenu({
  files,
  sessions,
  query,
  onPick,
}: {
  files: string[];
  sessions: SessionSummary[];
  query: string;
  onPick: (value: string) => void;
}) {
  const fileMatches = filterMentions(files, query, 6);
  const sessionMatches = sessions
    .filter((session) => session.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 3);

  if (fileMatches.length === 0 && sessionMatches.length === 0) {
    return null;
  }

  return (
    <div className="slash-menu" role="listbox" aria-label="Files and sessions">
      {fileMatches.length > 0 && (
        <div className="slash-group" role="presentation">
          FILES
        </div>
      )}
      {fileMatches.map((file) => (
        <button key={file} className="slash-item" role="option" aria-selected={false} onClick={() => onPick(file)}>
          <span className="codicon codicon-file" />
          <span className="slash-name">{file.split('/').pop()}</span>
          <span className="slash-desc">{file}</span>
        </button>
      ))}
      {sessionMatches.length > 0 && (
        <div className="slash-group" role="presentation">
          SESSIONS
        </div>
      )}
      {sessionMatches.map((session) => (
        <button
          key={session.id}
          className="slash-item"
          role="option"
          aria-selected={false}
          onClick={() => onPick(`session:${session.title}`)}
        >
          <span className="codicon codicon-history" />
          <span className="slash-name">{session.title}</span>
          <span className="slash-desc">{session.messageCount} messages</span>
        </button>
      ))}
    </div>
  );
}
