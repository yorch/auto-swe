'use client';

import { useState } from 'react';

/**
 * Text-input state seeded from a server value, re-seeded whenever that value
 * changes (first load, or a refetch after save). Pair with `clearableField` so
 * an unchanged field is omitted and an emptied one is sent as `null`.
 */
export function usePrefilledField(
  current: string | number | null | undefined
): [string, (value: string) => void] {
  const asText = current == null ? '' : String(current);
  const [value, setValue] = useState(asText);
  const [seeded, setSeeded] = useState(asText);
  if (asText !== seeded) {
    setSeeded(asText);
    setValue(asText);
  }
  return [value, setValue];
}
