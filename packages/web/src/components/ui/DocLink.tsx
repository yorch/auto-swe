import Link from 'next/link';
import { cn, FOCUS_RING } from '@/lib/utils';
import { Icon } from './Icon';

/** The `/docs` URL for a doc slug and an optional heading id. */
export function docHref(slug: string, anchor?: string): string {
  return anchor ? `/docs/${slug}#${anchor}` : `/docs/${slug}`;
}

/**
 * A link into the in-app documentation reader. Navigates in the same tab unless `newTab` is set,
 * which a page the reader would navigate away from mid-task (an OAuth consent screen) needs.
 */
export function DocLink({
  slug,
  anchor,
  label = 'Learn more',
  className,
  newTab = false,
}: {
  slug: string;
  anchor?: string;
  label?: string;
  className?: string;
  newTab?: boolean;
}) {
  return (
    <Link
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm text-sm text-ember-300 transition-colors hover:text-ember-200',
        FOCUS_RING,
        className
      )}
      href={docHref(slug, anchor)}
      {...(newTab ? { rel: 'noopener noreferrer', target: '_blank' } : {})}
    >
      <Icon name="docs" size={14} />
      {label}
      {newTab && ' '}
      {newTab && <span className="sr-only">(opens in a new tab)</span>}
    </Link>
  );
}
