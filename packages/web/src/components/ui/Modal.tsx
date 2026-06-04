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

  return (
    <dialog
      className={`m-auto ${width} rounded-sm border border-ink-500 bg-ink-900 p-0 text-paper-100 backdrop:bg-ink-950/70`}
      onClose={onClose}
      ref={dialogRef}
    >
      <div className="space-y-6 p-6">
        <header className="space-y-1">
          {eyebrow && (
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-paper-500">
              {eyebrow}
            </div>
          )}
          <h2 className="font-display text-2xl text-paper-50">{title}</h2>
          {subtitle && <div className="text-xs text-paper-500">{subtitle}</div>}
        </header>
        {children}
      </div>
    </dialog>
  );
}
