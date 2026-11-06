'use client';

import { useMemo } from 'react';
import { DiffFile, type DiffFileProps } from '@/components/diff/DiffFile';
import { useSyntax } from '@/hooks/useSyntax';

/**
 * A file of the review page's diff, which colours its code once it is opened. The colouring is
 * worked out per file and only for an open one, so a long change costs what is on screen.
 *
 * `onComment` names the file with the line, so one stable handler can serve every file of the page.
 */
export function ReviewDiffFile({
  onComment,
  path,
  ...props
}: Omit<DiffFileProps, 'onLineComment'> & {
  onComment?: ((path: string, line: number) => void) | undefined;
  path: string;
}) {
  const syntax = useSyntax(path, props.lines, props.open);
  const onLineComment = useMemo(
    () => (onComment ? (line: number) => onComment(path, line) : undefined),
    [onComment, path]
  );
  return <DiffFile {...props} onLineComment={onLineComment} syntax={syntax} />;
}
