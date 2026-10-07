import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { cn, FOCUS_RING } from '@/lib/utils';

/** The "← Parent list" link above a govern detail page's header. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm text-[13px] text-paper-400 transition-colors hover:text-paper-100',
        FOCUS_RING
      )}
      href={href}
    >
      <Icon name="arrowLeft" size={14} />
      {label}
    </Link>
  );
}
