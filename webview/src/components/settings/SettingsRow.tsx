import type { ReactNode } from 'react';

export function SettingsRow({
  label,
  description,
  children,
  last,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`settings-row ${last ? 'last' : ''}`}>
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {description && <div className="settings-row-desc">{description}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
