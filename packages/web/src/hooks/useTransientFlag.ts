'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A boolean that flips true on `trigger()` and back to false after `ms`, or
 * immediately on `reset()`.
 *
 * Backs the "✓ saved" / "✓ copied" confirmations. The timer is cleared on
 * unmount and on a re-trigger: without that, dismissing the modal or leaving
 * the page inside the window fires `setState` on an unmounted component, and
 * a second click before the first timer expires ends the flag early.
 */
export function useTransientFlag(ms = 1500): [boolean, () => void, () => void] {
  const [on, setOn] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clear, [clear]);

  const trigger = useCallback(() => {
    clear();
    setOn(true);
    timerRef.current = setTimeout(() => setOn(false), ms);
  }, [clear, ms]);

  const reset = useCallback(() => {
    clear();
    setOn(false);
  }, [clear]);

  return [on, trigger, reset];
}
