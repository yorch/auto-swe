'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { cn, FOCUS_RING } from '@/lib/utils';

interface TabItem<T extends string> {
  id: T;
  label: string;
  /** Renders the tab as a link. Use it when each tab is its own route. */
  href?: string;
}

/** Props for the panel a tab controls; pair with `<TabBar idPrefix>`. */
export function tabPanelProps(idPrefix: string, id: string) {
  return {
    'aria-labelledby': `${idPrefix}-tab-${id}`,
    id: `${idPrefix}-panel-${id}`,
    role: 'tabpanel' as const,
  };
}

/**
 * Fades the right edge of a scrolling tab row to say there is more. A mask rather than an
 * overlay, so it works on any card background; hidden from md up, where the row fits.
 */
const FADE_RIGHT =
  '[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] md:[mask-image:none]';

/**
 * Underlined section tabs. Tabs with an `href` are `next/link`s in a labelled
 * `<nav>`, marked `aria-current="page"` when active — sub-pages stay linkable,
 * middle-clickable and prefetched. Tabs without one are in-page sections and
 * follow the ARIA tabs pattern: a `tablist` of `role="tab"` buttons with
 * `aria-selected`, a roving tabindex and Left/Right/Home/End navigation.
 * `ariaLabel` names the group.
 */
export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  className,
  ariaLabel = 'Sections',
  idPrefix,
}: {
  tabs: TabItem<T>[];
  active: T;
  onChange?: (id: T) => void;
  className?: string;
  ariaLabel?: string;
  /**
   * Links each in-page tab to its panel: tabs get `aria-controls`, and the page
   * spreads {@link tabPanelProps} with the same prefix onto the panel.
   */
  idPrefix?: string;
}) {
  const generated = useId();
  const baseId = idPrefix ?? generated;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const isLinkBar = tabs.some((t) => t.href);
  const scroller = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);

  // A fade at the right edge tells a phone user the strip scrolls on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the tab set changes
  useEffect(() => {
    const el = scroller.current;
    if (!el) {
      return;
    }
    const measure = () => setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [tabs.length]);

  const tabClass = (selected: boolean) =>
    cn(
      'shrink-0 whitespace-nowrap border-b-2 px-4 py-2 text-sm transition-colors',
      FOCUS_RING,
      selected
        ? 'border-ember-400 text-ember-400'
        : 'border-transparent text-paper-400 hover:text-paper-100'
    );

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') {
      next = (index + 1) % tabs.length;
    } else if (e.key === 'ArrowLeft') {
      next = (index - 1 + tabs.length) % tabs.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = tabs.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    refs.current[next]?.focus();
    onChange?.(tabs[next].id);
  };

  return (
    <div className={cn('relative border-b border-ink-600', className)}>
      {isLinkBar ? (
        <nav
          aria-label={ariaLabel}
          className={cn('flex gap-1 overflow-x-auto', moreRight && FADE_RIGHT)}
          ref={scroller}
        >
          {tabs.map((tab) =>
            tab.href ? (
              <Link
                aria-current={active === tab.id ? 'page' : undefined}
                className={tabClass(active === tab.id)}
                href={tab.href}
                key={tab.id}
              >
                {tab.label}
              </Link>
            ) : (
              <button
                aria-pressed={active === tab.id}
                className={tabClass(active === tab.id)}
                key={tab.id}
                onClick={() => onChange?.(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            )
          )}
        </nav>
      ) : (
        <div
          aria-label={ariaLabel}
          className={cn('flex gap-1 overflow-x-auto', moreRight && FADE_RIGHT)}
          ref={scroller}
          role="tablist"
        >
          {tabs.map((tab, i) => {
            const selected = active === tab.id;
            return (
              <button
                // Only the selected panel is rendered, so only it can be controlled.
                aria-controls={idPrefix && selected ? `${idPrefix}-panel-${tab.id}` : undefined}
                aria-selected={selected}
                className={tabClass(selected)}
                id={`${baseId}-tab-${tab.id}`}
                key={tab.id}
                onClick={() => onChange?.(tab.id)}
                onKeyDown={(e) => onKeyDown(e, i)}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
