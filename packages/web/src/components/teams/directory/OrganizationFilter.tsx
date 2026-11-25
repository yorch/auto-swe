'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useDirectoryOrganizations } from '@/hooks/useJoinRequests';
import type { CreatableOrg } from '@/lib/joinRequests';
import { cn, FIELD_FOCUS } from '@/lib/utils';

const ALL = '__all__';
const MORE = '__more__';

type Row =
  | { kind: 'all'; key: typeof ALL }
  | { kind: 'org'; key: string; org: CreatableOrg }
  | { kind: 'more'; key: typeof MORE };

/**
 * The directory's organization filter: a typeahead over the gateway's organization search, so it
 * works however many organizations exist. Typing searches by name on the server (debounced), the
 * list pages on with "Load more", and the chosen organization stays shown whether or not it is in
 * the loaded page. It follows the ARIA combobox pattern: the input keeps focus and names the active
 * option through `aria-activedescendant`; Arrow keys move, Enter chooses, Escape closes.
 */
export function OrganizationFilter({
  initial,
  onChange,
  selected,
}: {
  /** The first page the directory already carries, shown until the search answers. */
  initial?: CreatableOrg[];
  onChange: (org: CreatableOrg | null) => void;
  /** The chosen organization, or null for all of them. */
  selected: CreatableOrg | null;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebouncedValue(editing ? text.trim() : '', 250);
  const initialPage = useMemo(
    () => (initial ? { nextCursor: null, organizations: initial } : undefined),
    [initial]
  );
  const search = useDirectoryOrganizations({ enabled: open, initial: initialPage, q });

  const orgs = (search.data?.pages ?? []).flatMap((p) => p.organizations);
  const rows: Row[] = [
    ...(q === '' && !editing ? [{ key: ALL, kind: 'all' } as const] : []),
    ...orgs.map((org) => ({ key: org.id, kind: 'org', org }) as const),
    ...(search.hasNextPage ? [{ key: MORE, kind: 'more' } as const] : []),
  ];
  const optionId = (key: string) => `${id}-opt-${key}`;
  const settling = editing && text.trim() !== q;
  const busy = search.isFetching && !search.isFetchingNextPage;

  // The highlighted row stays inside the list when the list changes under it.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  function close() {
    setOpen(false);
    setEditing(false);
    setText('');
  }

  function choose(row: Row | undefined) {
    if (!row) {
      return;
    }
    if (row.kind === 'more') {
      void search.fetchNextPage();
      return;
    }
    onChange(row.kind === 'org' ? row.org : null);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setActive((i) => Math.min(i + 1, rows.length - 1));
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        if (open) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (open) {
          e.preventDefault();
          setActive(Math.max(rows.length - 1, 0));
        }
        break;
      case 'Enter':
        if (open) {
          e.preventDefault();
          choose(rows[active]);
        }
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          close();
        }
        break;
      case 'Tab':
        close();
        break;
      default:
    }
  }

  const activeKey = open ? rows[active]?.key : undefined;
  const shown = editing ? text : (selected?.name ?? '');
  const status = search.isError
    ? 'Could not load organizations.'
    : settling || busy
      ? 'Searching…'
      : orgs.length === 0
        ? 'No organization matches.'
        : '';

  return (
    <div className="relative inline-block w-full sm:w-64">
      <div className="relative">
        <input
          aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={open}
          aria-label="Filter by organization"
          autoComplete="off"
          className={cn(
            'h-8 pointer-coarse:min-h-[44px] w-full rounded-md border border-ink-200 bg-ink-900 pr-14 pl-2.5 text-sm text-paper-100 transition-colors placeholder:text-paper-600 hover:border-paper-600',
            FIELD_FOCUS
          )}
          // The list keeps the input focused when pressed, so a blur is the person leaving.
          onBlur={close}
          onChange={(e) => {
            setText(e.target.value);
            setEditing(true);
            setOpen(true);
            setActive(0);
          }}
          onClick={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="All organizations"
          role="combobox"
          type="text"
          value={shown}
        />
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
          {selected && (
            <button
              aria-label="Clear organization filter"
              className="rounded p-1 text-paper-500 hover:text-paper-100"
              onClick={() => {
                onChange(null);
                close();
              }}
              onMouseDown={(e) => e.preventDefault()}
              type="button"
            >
              <Icon name="close" size={12} />
            </button>
          )}
          <span aria-hidden="true" className="p-1 text-paper-500">
            <Icon name="search" size={12} />
          </span>
        </div>
      </div>
      {open && (
        <div className="absolute z-30 mt-1 max-h-72 w-full min-w-56 overflow-auto rounded-md border border-ink-300 bg-ink-800 py-1 shadow-lg">
          <div
            aria-label="Organizations"
            id={listId}
            // The input must keep focus, so a press on the list is not a blur.
            onMouseDown={(e) => e.preventDefault()}
            role="listbox"
            tabIndex={-1}
          >
            {rows.map((row, i) => (
              <button
                aria-selected={
                  row.kind === 'org' ? row.org.id === selected?.id : row.kind === 'all' && !selected
                }
                className={cn(
                  'block w-full cursor-pointer px-2.5 py-1.5 text-left text-sm',
                  i === active ? 'bg-ink-600 text-paper-50' : 'text-paper-200',
                  row.kind === 'more' && 'text-accent-400'
                )}
                id={optionId(row.key)}
                key={row.key}
                onClick={() => choose(row)}
                onMouseEnter={() => setActive(i)}
                role="option"
                tabIndex={-1}
                type="button"
              >
                {row.kind === 'all'
                  ? 'All organizations'
                  : row.kind === 'org'
                    ? row.org.name
                    : search.isFetchingNextPage
                      ? 'Loading…'
                      : 'Load more'}
              </button>
            ))}
          </div>
          {/* Not an option: it says why the list is short or still loading. */}
          {status && (
            <p aria-live="polite" className="px-2.5 py-1.5 text-sm text-paper-500" role="status">
              {status}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
