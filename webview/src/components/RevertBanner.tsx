import { post } from '../vscode';

export function RevertBanner({
  canRedo,
  files,
}: {
  canRedo: boolean;
  files: Array<{ path: string; additions: number; deletions: number }>;
}) {
  if (!canRedo) {
    return null;
  }
  return (
    <div className="revert-banner anim-slide-in">
      <span className="codicon codicon-history" />
      <div className="revert-info">
        <div className="revert-text">Reverted {files.length} file{files.length === 1 ? '' : 's'}.</div>
        {files.length > 0 && (
          <ul className="revert-files">
            {files.slice(0, 4).map((file) => (
              <li key={file.path}>
                <span className="revert-path">{file.path}</span>{' '}
                <span className="add">+{file.additions}</span> <span className="del">-{file.deletions}</span>
              </li>
            ))}
            {files.length > 4 && <li>… and {files.length - 4} more</li>}
          </ul>
        )}
      </div>
      <span className="spacer" />
      <button className="btn-small" title="Restore the state from before the revert" onClick={() => post({ type: 'redoRevert' })}>
        <span className="codicon codicon-redo" /> Redo
      </button>
    </div>
  );
}
