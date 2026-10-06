'use client';

import { useEffect, useState } from 'react';
import type { TocEntry } from '@/lib/docToc';
import { cn, FOCUS_RING } from '@/lib/utils';

/**
 * "On this page" for a doc: its h2/h3 headings, with the one being read
 * highlighted as the page scrolls. The highlight is a convenience on top of
 * plain anchor links, so the list works the same before hydration.
 */
export function DocToc({ className, toc }: { className?: string; toc: TocEntry[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }
    const headings = toc
      .map((entry) => document.getElementById(entry.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActive(visible[0].target.id);
        }
      },
      // A heading counts as "being read" once it reaches the top third of the viewport.
      { rootMargin: '0px 0px -66% 0px' }
    );
    for (const h of headings) {
      observer.observe(h);
    }
    return () => observer.disconnect();
  }, [toc]);

  return (
    <ul className={cn('space-y-0.5 border-l border-ink-600 text-[13px]', className)}>
      {toc.map((entry) => {
        const current = entry.id === active;
        return (
          <li key={entry.id}>
            <a
              aria-current={current ? 'location' : undefined}
              className={cn(
                '-ml-px block border-l py-1 leading-snug transition-colors',
                entry.level === 3 ? 'pl-6' : 'pl-3',
                current
                  ? 'border-ember-400 text-paper-50'
                  : 'border-transparent text-paper-500 hover:border-ink-300 hover:text-paper-200',
                FOCUS_RING
              )}
              href={`#${entry.id}`}
            >
              {entry.text}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
