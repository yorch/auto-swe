'use client';

import { useEffect, useState } from 'react';
import type { ParsedDiffLine } from '@/components/approvals/diffParse';
import { type LineSyntax, syntaxForDiff } from '@/lib/diffSyntax';

/**
 * The grammar's colours for a file's lines, or null until they are ready, and for ever for a file
 * that cannot be coloured. Nothing is loaded or worked out until `enabled`, so a file that stays
 * closed costs nothing, and once worked out for these lines they are kept while the file toggles.
 * The lines draw plain until the colours arrive and are never held up by them.
 */
export function useSyntax(
  path: string,
  lines: readonly ParsedDiffLine[],
  enabled: boolean
): LineSyntax | null {
  const [done, setDone] = useState<{
    lines: readonly ParsedDiffLine[];
    syntax: LineSyntax | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled || done?.lines === lines) {
      return;
    }
    let current = true;
    syntaxForDiff(path, lines).then(
      (syntax) => {
        if (current) {
          setDone({ lines, syntax });
        }
      },
      () => {
        if (current) {
          setDone({ lines, syntax: null });
        }
      }
    );
    return () => {
      current = false;
    };
  }, [done, enabled, lines, path]);

  return done?.lines === lines ? done.syntax : null;
}
