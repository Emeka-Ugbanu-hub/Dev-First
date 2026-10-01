import type { ReactNode } from 'react';

export function plainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(plainText).join('');
  }
  if (typeof node === 'object' && 'props' in (node as { props?: { children?: ReactNode } })) {
    return plainText((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}
