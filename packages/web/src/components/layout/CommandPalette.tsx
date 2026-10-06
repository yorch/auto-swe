'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, isIconName } from '@/components/ui/Icon';
import { useVisibleNavGroups } from '@/hooks/useVisibleNav';
import { cn, FOCUS_RING } from '@/lib/utils';

interface Entry {
  href: string;
  label: string;
  group: string;
  icon: string;
}

/** Case-insensitive subsequence match, scored so a prefix or word-start hit ranks first. */
function score(query: string, entry: Entry): number {
  const q = query.trim().toLowerCase();
  if (!q) {
    return 1;
  }
  const label = entry.label.toLowerCase();
  if (label.startsWith(q)) {
    return 100;
  }
  if (label.split(/\s+/).some((w) => w.startsWith(q))) {
    return 80;
  }
  if (label.includes(q)) {
    return 60;
  }
  if (`${entry.group} ${label}`.toLowerCase().includes(q)) {
    return 40;
  }
  let i = 0;
  for (const ch of label) {
    if (ch === q[i]) {
      i += 1;
    }
  }
  return i === q.length ? 10 : 0;
}

/**
 * Jump to any page the user may open by typing part of its name. Opens on
 * ⌘K / Ctrl+K from anywhere, or from the TopBar's search button. Built as a
 * combobox over a listbox: the input keeps focus, arrows move the active option,
 * Enter opens it, Escape closes.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Global shortcut.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  // The dialog (and the nav queries it reads) mounts only while open.
  if (!open || !mounted) {
    return null;
  }
  return createPortal(<PaletteDialog onClose={() => onOpenChange(false)} />, document.body);
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const groups = useVisibleNavGroups();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const listId = useId();

  const entries = useMemo<Entry[]>(
    () => [
      { group: 'Actions', href: '/start', icon: 'plus', label: 'Start work' },
      ...groups.flatMap((g) =>
        g.items.map((item) => ({
          group: item.section ? `${g.label} · ${item.section}` : g.label,
          href: item.href,
          icon: item.icon,
          label: item.label,
        }))
      ),
    ],
    [groups]
  );

  const results = useMemo(
    () =>
      entries
        .map((e) => ({ e, s: score(query, e) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((r) => r.e),
    [entries, query]
  );

  // Focus the search on open; hand focus back to where it was on close.
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      restoreRef.current?.focus?.();
    };
  }, []);

  const go = (entry: Entry | undefined) => {
    if (!entry) {
      return;
    }
    onClose();
    router.push(entry.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        aria-label="Go to page"
        aria-modal="true"
        className="relative w-full max-w-xl overflow-hidden rounded-xl border border-ink-400 bg-ink-800 shadow-2xl shadow-black/50"
        role="dialog"
      >
        <div className="flex items-center gap-3 border-b border-ink-500 px-4">
          <Icon className="text-paper-500" name="search" size={16} />
          <input
            aria-controls={listId}
            aria-label="Search pages"
            className="h-12 w-full bg-transparent text-[15px] text-paper-50 outline-none placeholder:text-paper-600"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search pages and actions…"
            ref={inputRef}
            type="search"
            value={query}
          />
          <kbd className="hidden rounded border border-ink-400 px-1.5 py-0.5 text-[11px] text-paper-500 sm:block">
            Esc
          </kbd>
        </div>
        <span aria-live="polite" className="sr-only">
          {results.length === 0 ? 'No matching pages' : `${results.length} pages`}
        </span>
        <ul className="max-h-[50vh] overflow-y-auto p-1.5" id={listId}>
          {results.length === 0 && (
            <li className="px-3 py-8 text-center text-sm text-paper-500">
              No page matches “{query}”.
            </li>
          )}
          {results.map((entry, i) => (
            <li key={`${entry.group}-${entry.href}`}>
              <button
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none',
                  i === active ? 'bg-ink-600 text-paper-50' : 'text-paper-300'
                )}
                onClick={() => go(entry)}
                onFocus={() => setActive(i)}
                onKeyDown={onKeyDown}
                onMouseMove={() => setActive(i)}
                type="button"
              >
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
                    i === active
                      ? 'border-ember-400/40 bg-ember-400/10 text-ember-300'
                      : 'border-ink-500 bg-ink-700 text-paper-500'
                  )}
                >
                  <Icon name={isIconName(entry.icon) ? entry.icon : 'dashboard'} size={14} />
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                <span className="shrink-0 text-xs text-paper-600">{entry.group}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-4 border-t border-ink-500 px-4 py-2 text-[11.5px] text-paper-600">
          <span>
            <kbd className="font-sans">↑↓</kbd> to move
          </span>
          <span>
            <kbd className="font-sans">↵</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}

/** The TopBar's entry point to the palette, styled as a search field. */
export function CommandPaletteButton({ onClick }: { onClick: () => void }) {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);
  return (
    <button
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-lg border border-ink-400/80 bg-ink-900/60 px-2.5 text-[13px] text-paper-500 transition-colors hover:border-ink-300 hover:text-paper-200 lg:w-60',
        FOCUS_RING
      )}
      onClick={onClick}
      type="button"
    >
      <Icon name="search" size={14} />
      <span className="max-lg:sr-only">Search…</span>
      <kbd className="ml-auto hidden rounded border border-ink-400 px-1.5 text-[11px] text-paper-500 lg:block">
        {isMac ? '⌘K' : 'Ctrl K'}
      </kbd>
    </button>
  );
}
