'use client';

import { useEffect, useState } from 'react';
import type { SupportInfo } from '@/lib/env';

/**
 * The operator's support contacts, or undefined when none are configured.
 *
 * Read after mount: the validated value lives on `window.__APP_CONFIG__`, which
 * does not exist during SSR, so reading it during render would hydrate
 * different markup than the server sent.
 */
export function useSupportInfo(): SupportInfo | undefined {
  const [support, setSupport] = useState<SupportInfo | undefined>(undefined);
  useEffect(() => {
    setSupport(
      (window as unknown as { __APP_CONFIG__?: { support?: SupportInfo } }).__APP_CONFIG__?.support
    );
  }, []);
  return support;
}
