import { useEffect, type RefObject } from 'react';

export function isEscapeKey(key: string): boolean {
  return key === 'Escape';
}

export function isOutsideTarget(
  target: EventTarget | null,
  container: { contains(node: Node | null): boolean } | null,
): boolean {
  if (!container) {
    return true;
  }
  if (!target) {
    return true;
  }
  return !container.contains(target as Node);
}

export function useOverlayDismiss(
  open: boolean,
  onClose: () => void,
  ref: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (isOutsideTarget(event.target, ref.current)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEscapeKey(event.key)) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, ref]);
}
