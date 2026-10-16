'use client';

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useOverlayPosition } from 'react-aria';
import { createPortal } from 'react-dom';
import { type GlossaryTerm, glossaryEntry } from '@/lib/glossary';
import { cn, FOCUS_RING } from '@/lib/utils';
import { DocLink } from './DocLink';
import { Icon } from './Icon';

const HIDE_DELAY_MS = 120;

type HelpTipProps = { className?: string } & (
  | {
      /** A glossary term: supplies the label, the definition and the docs link. */
      term: GlossaryTerm;
      /** Replaces the glossary definition (the docs link is kept). */
      children?: ReactNode;
      label?: string;
    }
  | {
      term?: undefined;
      /** Custom help text. */
      children: ReactNode;
      /** What the tip is about; names the button ("About {label}"). */
      label: string;
    }
);

function whatIs(label: string): string {
  const name = label.toLowerCase();
  return `What is ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}?`;
}

/**
 * A small "?" button beside a label. Hover, focus or click opens a popover with
 * the glossary definition of `term` (or custom `children`) and a link to the
 * docs. Escape, a click outside, or focus leaving closes it. The popover is
 * portaled to the body (or, inside a modal `<dialog>`, into that dialog) and
 * positioned by React Aria, so a table or an `overflow` container never clips it. Escape closes
 * only the tip, never the dialog around it.
 */
export function HelpTip(props: HelpTipProps) {
  const { className } = props;
  const entry = props.term ? glossaryEntry(props.term) : undefined;
  const label = props.label ?? entry?.label ?? '';
  const body = props.children ?? entry?.definition;
  const doc = entry?.doc;
  const buttonName = props.term ? whatIs(label) : `About ${label}`;

  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const popoverId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerDown = useRef(false);
  // Where the popover portals. A shown <dialog> sits in the top layer, above anything portaled
  // to <body>, so inside one the popover must live in that dialog to be visible at all.
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const cancelHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
  }, []);
  const close = useCallback(() => {
    cancelHide();
    setOpen(false);
    setPinned(false);
  }, [cancelHide]);
  const show = useCallback(() => {
    cancelHide();
    setContainer(buttonRef.current?.closest('dialog') ?? document.body);
    setOpen(true);
  }, [cancelHide]);
  const hideSoon = useCallback(() => {
    cancelHide();
    hideTimer.current = setTimeout(close, HIDE_DELAY_MS);
  }, [cancelHide, close]);

  useEffect(() => cancelHide, [cancelHide]);

  const { overlayProps, updatePosition } = useOverlayPosition({
    containerPadding: 8,
    isOpen: open,
    offset: 6,
    onClose: close,
    overlayRef: popoverRef,
    placement: 'bottom start',
    targetRef: buttonRef,
  });

  // Position once the popover is in the DOM (it needs its own size to flip).
  useEffect(() => {
    if (open) {
      updatePosition();
    }
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Only the tip closes: a native <dialog> would otherwise take Escape as its own cancel.
        event.preventDefault();
        event.stopPropagation();
        // Only take focus back when it was in the tip; a tip opened by hover must not pull focus
        // away from, say, a field the person is typing in.
        const active = document.activeElement;
        const focusInTip =
          !!active && (buttonRef.current?.contains(active) || popoverRef.current?.contains(active));
        close();
        if (focusInTip) {
          // Returning focus must not read as a keyboard focus that reopens the tip.
          pointerDown.current = true;
          buttonRef.current?.focus();
          pointerDown.current = false;
        }
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  const leftTipFocus = (next: EventTarget | null) =>
    !(next instanceof Node) ||
    (!buttonRef.current?.contains(next) && !popoverRef.current?.contains(next));

  return (
    <span className={cn('inline-flex align-middle', className)}>
      <button
        aria-controls={open ? popoverId : undefined}
        aria-describedby={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={buttonName}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded-full text-paper-500 transition-colors hover:text-paper-100',
          open && 'text-ember-300',
          FOCUS_RING
        )}
        onBlur={(event) => {
          pointerDown.current = false;
          if (leftTipFocus(event.relatedTarget)) {
            close();
          }
        }}
        onClick={() => {
          pointerDown.current = false;
          if (open && pinned) {
            close();
          } else {
            show();
            setPinned(true);
          }
        }}
        onFocus={() => {
          // A mouse press focuses first and then clicks; let the click decide.
          if (!pointerDown.current) {
            show();
          }
        }}
        onKeyDown={(event) => {
          // The popover is portaled, so Tab would skip its link: step into it.
          if (event.key === 'Tab' && !event.shiftKey && open) {
            const link = popoverRef.current?.querySelector<HTMLElement>('a');
            if (link) {
              event.preventDefault();
              link.focus();
            }
          }
        }}
        onPointerDown={() => {
          pointerDown.current = true;
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') {
            show();
          }
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse' && !pinned) {
            hideSoon();
          }
        }}
        ref={buttonRef}
        type="button"
      >
        <Icon name="help" size={14} />
      </button>
      {open &&
        container &&
        createPortal(
          <div
            {...overlayProps}
            aria-label={label}
            className="z-50 w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-ink-400 bg-ink-800 p-3 text-left text-sm font-normal normal-case leading-relaxed tracking-normal text-paper-200 shadow-2xl shadow-black/40"
            id={popoverId}
            onBlur={(event) => {
              if (leftTipFocus(event.relatedTarget)) {
                close();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Tab') {
                const link = popoverRef.current?.querySelector<HTMLElement>('a');
                if (event.shiftKey || event.target !== link || !link) {
                  event.preventDefault();
                  buttonRef.current?.focus();
                } else {
                  // Leaving forward: park focus on the button so Tab continues from it.
                  buttonRef.current?.focus();
                  close();
                }
              }
            }}
            onPointerEnter={cancelHide}
            onPointerLeave={() => {
              if (!pinned) {
                hideSoon();
              }
            }}
            ref={popoverRef}
            role="dialog"
          >
            <p className="text-paper-100">{body}</p>
            {doc && (
              <p className="mt-2">
                <DocLink
                  anchor={doc.anchor}
                  label={`Learn more about ${label.toLowerCase()}`}
                  slug={doc.slug}
                />
              </p>
            )}
          </div>,
          container
        )}
    </span>
  );
}
