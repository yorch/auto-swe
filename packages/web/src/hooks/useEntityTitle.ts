'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useId } from 'react';
import type { DetailParent } from '@/lib/navigation';
import { useEntityTitleStore } from '@/stores/entityTitleStore';

export function useEntityTitle(title: string | null | undefined, parent?: DetailParent) {
  const pathname = usePathname();
  const owner = useId();
  const href = parent?.href;
  const label = parent?.label;
  const section = parent?.section;
  useEffect(() => {
    if (!title?.trim()) {
      return;
    }
    const store = useEntityTitleStore.getState();
    store.publish({
      owner,
      parent: href && label ? { href, label, section } : undefined,
      pathname,
      title: title.trim(),
    });
    return () => store.clear(owner);
  }, [pathname, title, owner, href, label, section]);
}
