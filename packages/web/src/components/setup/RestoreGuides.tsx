'use client';

import { useEffect, useState } from 'react';
import { FIRST_RUN_DISMISS_KEY } from '@/components/setup/FirstRunChecklist';
import { GOVERNANCE_DISMISS_KEY } from '@/components/setup/GovernanceGuide';
import { Button } from '@/components/ui/Button';
import { useHasRole } from '@/hooks/useHasRole';
import { clearDismissed, DISMISSED_CHANGE_EVENT, readDismissed } from '@/lib/dismissed';
import { useAuthStore } from '@/stores/authStore';

/**
 * A quiet line at the foot of Home that brings back a getting-started guide the person hid:
 * the governance guide for an admin, the first-run checklist for everyone else. Dismissed
 * flags live in this browser only, so without this a dismissed guide has no way back.
 * Renders nothing while no guide is hidden.
 */
export function RestoreGuides() {
  const isAdmin = useHasRole('ADMIN');
  const userId = useAuthStore((s) => s.user?.sub);
  const key = isAdmin ? GOVERNANCE_DISMISS_KEY : FIRST_RUN_DISMISS_KEY;
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const read = () => setHidden(readDismissed(key, userId));
    read();
    window.addEventListener(DISMISSED_CHANGE_EVENT, read);
    return () => window.removeEventListener(DISMISSED_CHANGE_EVENT, read);
  }, [key, userId]);

  if (!hidden) {
    return null;
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm text-paper-400">
      {isAdmin ? 'The governance guide is hidden.' : 'The first-run checklist is hidden.'}
      <Button onClick={() => clearDismissed(key, userId)} size="sm" variant="ghost">
        Show it again
      </Button>
    </p>
  );
}
