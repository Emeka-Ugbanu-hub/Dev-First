import type { ReactNode } from 'react';

export function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`collapsible ${open ? 'open' : ''}`}>
      <div className="collapsible-inner">{children}</div>
    </div>
  );
}
