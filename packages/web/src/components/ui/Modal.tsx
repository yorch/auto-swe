'use client';

import { useEffect, useRef } from 'react';

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  subtitle,
  children,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  size?: 'md' | 'lg';
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const width = size === 'lg' ? 'w-[min(720px,92vw)]' : 'w-[min(560px,92vw)]';
  // Names the dialog from its own heading, so it is announced as more than
  // "dialog". Derived from the title so callers cannot forget it.
  const titleId = `modal-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return (
    <dialog
      aria-labelledby={titleId}
      className={`m-auto ${width} border border-ink-400 bg-ink-900 p-0 text-paper-100 backdrop:bg-ink-950/80`}
      onClose={onClose}
      ref={dialogRef}
      style={{ borderRadius: 14 }}
    >
      <div className="space-y-6 p-6">
        <header className="space-y-1">
          {eyebrow && (
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-paper-500">
              {eyebrow}
            </div>
          )}
          <h2 className="font-display text-2xl text-paper-50" id={titleId}>
            {title}
          </h2>
          {subtitle && <div className="text-xs text-paper-500">{subtitle}</div>}
        </header>
        {children}
      </div>
    </dialog>
  );
}
