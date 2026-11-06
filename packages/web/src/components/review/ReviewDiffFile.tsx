'use client';

import { DiffFile, type DiffFileProps } from '@/components/diff/DiffFile';
import { useSyntax } from '@/hooks/useSyntax';

/**
 * A file of the review page's diff, which colours its code once it is opened. The colouring is
 * worked out per file and only for an open one, so a long change costs what is on screen.
 */
export function ReviewDiffFile({ path, ...props }: DiffFileProps & { path: string }) {
  const syntax = useSyntax(path, props.lines, props.open);
  return <DiffFile {...props} syntax={syntax} />;
}
