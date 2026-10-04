'use client';

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { UNSAFE_PortalProvider } from 'react-aria';
import { createPortal } from 'react-dom';
import { Button, ButtonLink } from './Button';

/**
 * The action row every modal ends with: a `ghost` Cancel on the left of the
 * primary action, right-aligned. Without `onSubmit` the primary button is
 * `type="submit"`, so a modal whose body is a `<form>` submits on Enter;
 * with it, the button is a plain click target. `isPending` disables the
 * action and swaps in `pendingLabel` (default: `submitLabel` + "…").
 * `children` render on the left of the row — a status line, a secondary
 * link, or a destructive action that sits apart from the pair. Leave out
 * `submitLabel` for a read-only modal: the row is then a single
 * `secondary` button (pass `cancelLabel="Close"`), since a lone ghost
 * button reads as disabled.
 */
export function ModalFooter({
  cancelLabel = 'Cancel',
  children,
  dangerous = false,
  disabled = false,
  isPending = false,
  onCancel,
  onSubmit,
  pendingLabel,
  submitHref,
  submitLabel,
}: {
  cancelLabel?: string;
  children?: ReactNode;
  dangerous?: boolean;
  disabled?: boolean;
  isPending?: boolean;
  onCancel: () => void;
  onSubmit?: () => void;
  pendingLabel?: string;
  /**
   * Renders the primary action as a link to this route rather than a button,
   * for an action that navigates. `onSubmit` then runs on click; `disabled`
   * and `isPending` do not apply to a link.
   */
  submitHref?: string;
  submitLabel?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
      {children && <div className="mr-auto min-w-0">{children}</div>}
      <Button
        disabled={isPending}
        onClick={onCancel}
        type="button"
        variant={submitLabel ? 'ghost' : 'secondary'}
      >
        {cancelLabel}
      </Button>
      {submitLabel && submitHref && (
        <ButtonLink href={submitHref} onClick={onSubmit} variant={dangerous ? 'danger' : 'primary'}>
          {submitLabel}
        </ButtonLink>
      )}
      {submitLabel && !submitHref && (
        <Button
          disabled={disabled || isPending}
          onClick={onSubmit}
          type={onSubmit ? 'button' : 'submit'}
          variant={dangerous ? 'danger' : 'primary'}
        >
          {isPending ? (pendingLabel ?? `${submitLabel}…`) : submitLabel}
        </Button>
      )}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  subtitle,
  children,
  size = 'md',
  closeOnBackdropClick = true,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  size?: 'md' | 'lg';
  /**
   * Turn off for a modal whose content cannot be shown again — a one-time
   * secret — so a stray click cannot discard it. The close button and Escape
   * still close it: both are deliberate.
   */
  closeOnBackdropClick?: boolean;
  /**
   * Turn off while the dialog is committed to an in-flight action: Escape, the
   * close button and the backdrop all stop dismissing it, so the user cannot
   * believe they cancelled something that still completes.
   */
  dismissible?: boolean;
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
  // "dialog". useId keeps it unique when several modals share a title, as the
  // per-row dialogs of a table do.
  const titleId = `modal-title-${useId()}`;

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
      onCancel={(e) => {
        // Escape fires `cancel` first; preventing it keeps the dialog open.
        if (!dismissible) {
          e.preventDefault();
        }
      }}
      onClick={(e) => {
        if (
          dismissible &&
          closeOnBackdropClick &&
          pressStartedOnBackdrop.current &&
          e.target === e.currentTarget
        ) {
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
            className="-mr-1 -mt-1 shrink-0 px-1 text-2xl leading-none text-paper-500 hover:text-paper-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!dismissible}
            onClick={() => dialogRef.current?.close()}
            type="button"
          >
            ×
          </button>
        </header>
        {/* A shown <dialog> sits in the browser's top layer, above everything
            portalled to <body> — so a dropdown opened in here would render
            behind it. Overlays from React Aria (Select, Combobox) portal into
            the dialog instead. */}
        <UNSAFE_PortalProvider getContainer={() => dialogRef.current}>
          {children}
        </UNSAFE_PortalProvider>
      </div>
    </dialog>,
    document.body
  );
}
