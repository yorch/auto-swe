'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { SetupReadiness } from '@/components/setup/SetupReadiness';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { useHasRole } from '@/hooks/useHasRole';
import { useReadiness } from '@/hooks/useReadiness';
import { cn, FOCUS_RING } from '@/lib/utils';

export function SetupIndicator() {
  const isAdmin = useHasRole('ADMIN');
  const { data, isError } = useReadiness(isAdmin);
  const pathname = usePathname();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const incomplete = !!data?.items.some((item) => !item.ok);
  const open = openFor === pathname && incomplete && isAdmin && !isError;
  useEffect(() => {
    if (openFor !== pathname || !incomplete || !isAdmin || isError) {
      setOpenFor(null);
    }
  }, [openFor, pathname, incomplete, isAdmin, isError]);
  useEffect(() => {
    if (!open) {
      return;
    }
    closeButton.current?.focus();
    const dismiss = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpenFor(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpenFor(null);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);
  if (!isAdmin || !data || isError || !incomplete) {
    return null;
  }
  const done = data.items.filter((item) => item.ok).length;
  const total = data.items.length;
  const close = () => {
    setOpenFor(null);
    trigger.current?.focus();
  };
  return (
    <div ref={root}>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Setup: ${done} of ${total} steps complete`}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-warning-400/40 bg-warning-400/10 px-2 py-1 text-xs text-warning-400 pointer-coarse:min-h-[44px]',
          FOCUS_RING
        )}
        onClick={() => setOpenFor(open ? null : pathname)}
        ref={trigger}
        type="button"
      >
        <Icon name="settings" size={14} />
        <span className="max-sm:hidden">Setup</span>
        <span className="tabular">
          {done}/{total}
        </span>
      </button>
      {open && (
        <div
          aria-label="Setup checklist"
          className="fixed top-16 right-3 z-50 max-h-[calc(100dvh-5rem)] w-[min(36rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-ink-400 bg-ink-900 p-3 shadow-2xl"
          id={panelId}
          role="dialog"
        >
          <div className="mb-2 flex justify-end">
            <IconButton
              aria-label="Close setup checklist"
              onClick={close}
              ref={closeButton}
              size="sm"
            >
              <Icon name="close" size={16} />
            </IconButton>
          </div>
          <SetupReadiness onNavigate={() => setOpenFor(null)} />
        </div>
      )}
    </div>
  );
}
