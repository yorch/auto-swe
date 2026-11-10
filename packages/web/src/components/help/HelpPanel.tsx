'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Modal } from '@/components/ui/Modal';
import { pageTitle } from '@/lib/navigation';
import { cn, FOCUS_RING } from '@/lib/utils';
import { useHelpStore } from '@/stores/helpStore';

export const HELP_PANEL_ID = 'help-panel';

/**
 * The "?" button in the top bar and the panel it opens. The panel is a modal dialog, so Escape
 * closes it, focus is held inside while it is open and returns to this button on close. What it
 * shows is whatever the current page rendered through `PageHelp`; a page with none gets a note
 * and a link to the docs.
 */
export function HelpButton() {
  const pathname = usePathname();
  const open = useHelpStore((s) => s.open);
  const setOpen = useHelpStore((s) => s.setOpen);
  const sections = useHelpStore((s) => s.sections);
  const setTarget = useHelpStore((s) => s.setTarget);
  const pageTour = useHelpStore((s) => s.pageTour);
  const requestTour = useHelpStore((s) => s.requestTour);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const targetRef = useCallback((node: HTMLDivElement | null) => setTarget(node), [setTarget]);
  // A link followed from inside the panel (the docs, a page's "Learn more") changes the route
  // under it; close it so the reader lands on the page, not on the new page's help.
  const shownFor = useRef(pathname);
  useEffect(() => {
    if (shownFor.current !== pathname) {
      shownFor.current = pathname;
      setOpen(false);
    }
  }, [pathname, setOpen]);
  // Close the panel first, then start the tour on the next tick: the dialog hands focus back to
  // its opener as it closes, and the tour card must be the last to take it.
  const startTour = (kind: 'product' | 'page') => {
    setOpen(false);
    const opener = buttonRef.current;
    setTimeout(() => requestTour(kind, opener), 0);
  };
  return (
    <>
      <IconButton
        aria-controls={HELP_PANEL_ID}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Help for this page"
        className={cn(open && 'border-accent-400/60 text-accent-300')}
        onClick={() => setOpen(true)}
        ref={buttonRef}
        shape="round"
        title="Help for this page"
        variant="outline"
      >
        <Icon name="help" size={14} />
      </IconButton>
      <Modal
        onClose={() => {
          setOpen(false);
          // A modal dialog hands focus back to its opener in a browser; say it here too so the
          // behaviour does not depend on how the dialog was dismissed.
          buttonRef.current?.focus();
        }}
        open={open}
        size="lg"
        title={`Help · ${pageTitle(pathname)}`}
      >
        <div id={HELP_PANEL_ID}>
          <div className="space-y-4 text-sm leading-relaxed text-paper-400" ref={targetRef} />
          {sections === 0 && (
            <p className="text-sm text-paper-400">There is no extra help for this page.</p>
          )}
          <div className="mt-6 flex flex-wrap gap-2 border-t border-ink-600 pt-4">
            {pageTour && (
              <Button onClick={() => startTour('page')} size="sm" variant="secondary">
                Tour this page
              </Button>
            )}
            <Button onClick={() => startTour('product')} size="sm" variant="secondary">
              Take the product tour
            </Button>
          </div>
          <p className="mt-4">
            <Link
              className={cn(
                'inline-flex items-center gap-1.5 rounded-sm text-sm text-paper-100 underline decoration-paper-600 underline-offset-2 hover:decoration-current',
                FOCUS_RING
              )}
              href="/docs"
            >
              <Icon name="docs" size={14} />
              Browse the documentation
            </Link>
          </p>
        </div>
      </Modal>
    </>
  );
}
