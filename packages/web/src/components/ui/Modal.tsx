'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  // The dialog is portalled to document.body: callers often own a modal from
  // inside a table row or list item, and a <dialog> under <tbody> is invalid
  // HTML that React reports as a hydration error. Portals need the DOM, so
  // render nothing until mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    // The dialog element only exists once the portal has mounted; the first
    // run of this effect (before `mounted` flips) has nothing to open.
    const dialog = mounted ? dialogRef.current : null;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, mounted]);

  const width = size === 'lg' ? 'w-[min(720px,92vw)]' : 'w-[min(560px,92vw)]';
  // Names the dialog from its own heading, so it is announced as more than
  // "dialog". Derived from the title so callers cannot forget it.
  const titleId = `modal-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  // A native <dialog> only dismisses itself on Escape. A click on the backdrop
  // targets the <dialog> element itself, since the content fills its box. The
  // press must start there too: a text selection dragged out of an input ends
  // its click on the dialog and must not discard the form.
  const pressStartedOnBackdrop = useRef(false);

  if (!mounted) {
    return null;
  }

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard equivalent of a backdrop click is Escape, which <dialog> handles natively
    <dialog
      aria-labelledby={titleId}
      className={`m-auto ${width} border border-ink-400 bg-ink-900 p-0 text-paper-100 backdrop:bg-ink-950/80`}
      onClick={(e) => {
        if (pressStartedOnBackdrop.current && e.target === e.currentTarget) {
          e.currentTarget.close();
        }
      }}
      onClose={onClose}
      onMouseDown={(e) => {
        pressStartedOnBackdrop.current = e.target === e.currentTarget;
      }}
      ref={dialogRef}
      style={{ borderRadius: 14 }}
    >
      <div className="space-y-6 p-6">
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            {eyebrow && (
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-paper-500">
                {eyebrow}
              </div>
            )}
            <h2 className="font-display text-2xl text-paper-50" id={titleId}>
              {title}
            </h2>
            {subtitle && <div className="text-xs text-paper-500">{subtitle}</div>}
          </div>
          {/* close() fires the dialog's close event, which calls onClose once. */}
          <button
            aria-label="Close"
            className="-mr-1 -mt-1 shrink-0 px-1 text-2xl leading-none text-paper-500 hover:text-paper-100"
            onClick={() => dialogRef.current?.close()}
            type="button"
          >
            ×
          </button>
        </header>
        {children}
      </div>
    </dialog>,
    document.body
  );
}
