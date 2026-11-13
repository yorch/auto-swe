'use client';

import { useEntityTitle } from '@/hooks/useEntityTitle';

/** Publishes a server-rendered detail page's loaded title to the client shell. */
export function EntityTitle({ title }: { title: string }) {
  useEntityTitle(title);
  return null;
}
