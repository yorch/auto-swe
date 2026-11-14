'use client';

import { useMemo } from 'react';
import { DiffFile, type DiffFileProps, type DiffSide } from '@/components/diff/DiffFile';
import { useSyntax } from '@/hooks/useSyntax';

/**
 * A file of the review page's diff, which colours its code once it is opened. The colouring is
 * worked out per file and only for an open one, so a long change costs what is on screen.
 *
 * `onComment` names the file with the line, so one stable handler can serve every file of the page.
 * The side and Shift state of the click are forwarded as they come.
 */
export function ReviewDiffFile({
  onComment,
  path,
  ...props
}: Omit<DiffFileProps, 'onLineComment'> & {
  onComment?: ((path: string, line: number, side?: DiffSide, shift?: boolean) => void) | undefined;
  path: string;
}) {
  const syntax = useSyntax(path, props.lines, props.open);
  const onLineComment = useMemo(
    () =>
      onComment
        ? (line: number, side?: DiffSide, shift?: boolean) => onComment(path, line, side, shift)
        : undefined,
    [onComment, path]
  );
  return <DiffFile {...props} onLineComment={onLineComment} syntax={syntax} />;
}
