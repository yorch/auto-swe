'use client';

import { usePathname } from 'next/navigation';
import { BackLink } from '@/components/ui/BackLink';
import { detailParent } from '@/lib/navigation';
import { useEntityTitleStore } from '@/stores/entityTitleStore';

export function DetailBackLink({ focused = false }: { focused?: boolean }) {
  const pathname = usePathname();
  const entry = useEntityTitleStore((s) => s.entry);
  const parent = (entry?.pathname === pathname && entry.parent) || detailParent(pathname);
  if (!parent) {
    return null;
  }
  return (
    <div
      className={
        focused ? 'shrink-0 border-b border-ink-600/40 bg-ink-900 px-4 py-1.5 md:px-6' : 'mb-4'
      }
    >
      <BackLink href={parent.href} label={parent.label} />
    </div>
  );
}
