import Link from 'next/link';
import { Fragment } from 'react';
import { cn, FOCUS_RING } from '@/lib/utils';

export interface BreadcrumbItem {
  label: string;
  /** Makes the segment a link back to that level. The leaf (last item) never takes one. */
  href?: string;
}

/**
 * Where you are: ancestors (linked when they have an `href`) and the current page last. Only the
 * leaf carries `aria-current="page"`, so a detail page can add its own segment after the list it
 * belongs to ([{ label: 'Work' }, { label: 'All runs', href: '/runs' }, { label: 'Run 1a2b' }])
 * and the list stays one click away. It truncates the leaf rather than wrapping.
 */
export function Breadcrumbs({
  className,
  items,
  compactAncestors = false,
}: {
  className?: string;
  items: readonly BreadcrumbItem[];
  compactAncestors?: boolean;
}) {
  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-[5rem] text-sm text-paper-400', className)}>
      <ol className="flex min-w-0 items-center">
        {items.map((item, i) => {
          const leaf = i === items.length - 1;
          return (
            <Fragment key={item.label}>
              <li
                className={cn(
                  leaf ? 'min-w-0' : 'shrink-0',
                  !leaf && compactAncestors && 'max-sm:hidden'
                )}
              >
                {leaf ? (
                  <span
                    aria-current="page"
                    className="block truncate font-semibold text-paper-100"
                    title={item.label}
                  >
                    {item.label}
                  </span>
                ) : item.href ? (
                  <Link
                    className={cn(
                      'rounded-sm underline-offset-2 hover:text-paper-100 hover:underline',
                      FOCUS_RING
                    )}
                    href={item.href}
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span>{item.label}</span>
                )}
              </li>
              {!leaf && (
                <li
                  aria-hidden="true"
                  className={cn(
                    'shrink-0 px-1.5 text-paper-600',
                    compactAncestors && 'max-sm:hidden'
                  )}
                >
                  ›
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
