'use client';

import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { cn, FOCUS_RING } from '@/lib/utils';

/** Below the cut, the block fades out, so the edge reads as "there is more", not as the end. */
const FADE = '[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]';

const TOGGLE = cn(
  'mt-1 rounded-sm text-xs text-ember-400 transition-colors hover:text-ember-300',
  FOCUS_RING
);

/**
 * A code or output block that shows its first `collapsedHeight` and expands in
 * place, instead of scrolling inside a fixed height.
 *
 * A fixed-height scroll box inside a scrolling pane traps the wheel: the reader
 * scrolls the page, the pointer lands on the block, and the block scrolls
 * instead. Here the block never scrolls vertically; it is cut, faded, and grows
 * to its full length on request, so the wheel always moves the page.
 *
 * `hasMore` says the caller is holding text back (a character cap), so the
 * toggle shows even when what is rendered fits. Pass `expanded` and
 * `onExpandedChange` to drive both from one state, so a single click both
 * lifts the cap and the height.
 */
export function ExpandablePre({
  children,
  className,
  collapsedHeight = '18rem',
  expanded: expandedProp,
  hasMore = false,
  labels = { less: 'Show less', more: 'Show all' },
  onExpandedChange,
  toggleClassName,
}: {
  children: ReactNode;
  className?: string;
  /** Any CSS length. */
  collapsedHeight?: string;
  expanded?: boolean;
  hasMore?: boolean;
  labels?: { less: string; more: string };
  onExpandedChange?: (expanded: boolean) => void;
  /** Placement for the toggle, such as padding to line it up inside a padded container. */
  toggleClassName?: string;
}) {
  const [expandedState, setExpandedState] = useState(false);
  const expanded = expandedProp ?? expandedState;
  const [overflowing, setOverflowing] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  // Measured after every render while collapsed: streamed content grows without
  // resizing the capped box, so a ResizeObserver alone would miss it. While
  // expanded the last answer stands, since there is nothing to compare against.
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && !expanded) {
      const next = el.scrollHeight > el.clientHeight + 1;
      setOverflowing((prev) => (prev === next ? prev : next));
    }
  });

  // A narrower pane wraps more lines, which can make a block that fit overflow.
  useEffect(() => {
    const el = preRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (!expanded) {
        setOverflowing(el.scrollHeight > el.clientHeight + 1);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);

  const setExpanded = (next: boolean) => {
    if (expandedProp === undefined) {
      setExpandedState(next);
    }
    onExpandedChange?.(next);
    if (!next) {
      // Collapsing a long block pulls the content under the reader up the page;
      // keep the toggle they just pressed in view.
      requestAnimationFrame(() => toggleRef.current?.scrollIntoView?.({ block: 'nearest' }));
    }
  };

  const cut = !expanded && overflowing;
  const showToggle = expanded || overflowing || hasMore;

  return (
    <>
      <pre
        className={cn('overflow-x-auto overflow-y-hidden', cut && FADE, className)}
        id={id}
        ref={preRef}
        style={expanded ? undefined : { maxHeight: collapsedHeight }}
      >
        {children}
      </pre>
      {showToggle && (
        <button
          aria-controls={id}
          aria-expanded={expanded}
          className={cn(TOGGLE, toggleClassName)}
          onClick={(e) => {
            // Trace rows are clickable themselves; the toggle must not also select the row.
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          ref={toggleRef}
          type="button"
        >
          {expanded ? labels.less : labels.more}
        </button>
      )}
    </>
  );
}
