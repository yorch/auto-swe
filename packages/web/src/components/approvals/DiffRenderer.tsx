'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Modal } from '@/components/ui/Modal';
import { cn, FOCUS_RING, plural } from '@/lib/utils';
import {
  isUnifiedDiff,
  type ParsedDiffFile,
  type ParsedDiffLine,
  parseUnifiedDiff,
} from './diffParse';

const LINE_CLASS: Record<ParsedDiffLine['kind'], string> = {
  add: 'bg-moss-400/10 text-moss-400',
  ctx: 'text-paper-300',
  del: 'bg-brick-400/10 text-brick-400',
  hunk: 'bg-dust-400/[0.07] text-dust-400',
  meta: 'text-paper-500',
};

function DiffLine({ line }: { line: ParsedDiffLine }) {
  return (
    <div className={cn('flex', LINE_CLASS[line.kind])}>
      <span
        aria-hidden="true"
        className="tabular w-10 shrink-0 select-none border-r border-ink-600/60 pr-2 text-right text-paper-600"
      >
        {line.oldNo ?? ''}
      </span>
      <span
        aria-hidden="true"
        className="tabular w-10 shrink-0 select-none border-r border-ink-600/60 pr-2 text-right text-paper-600"
      >
        {line.newNo ?? ''}
      </span>
      <span className="whitespace-pre px-2">{line.text || ' '}</span>
    </div>
  );
}

function DiffBody({ files, maxHeight }: { files: ParsedDiffFile[]; maxHeight: string }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return (
    <div className={cn(maxHeight, 'space-y-2 overflow-auto')}>
      {files.map((file, i) => {
        const key = `${i}:${file.name}`;
        const isClosed = closed[key] === true;
        return (
          <section
            className="overflow-hidden rounded-lg border border-ink-500/60 bg-ink-950/50"
            key={key}
          >
            <button
              aria-expanded={!isClosed}
              className={cn(
                FOCUS_RING,
                'flex w-full items-center gap-2 bg-ink-800 px-3 py-2 text-left text-xs transition-colors hover:bg-ink-700'
              )}
              onClick={() => setClosed((c) => ({ ...c, [key]: !isClosed }))}
              type="button"
            >
              <Icon
                className={cn('text-paper-500 transition-transform', !isClosed && 'rotate-90')}
                name="chevronRight"
                size={13}
              />
              <span className="min-w-0 flex-1 break-all font-mono text-paper-100">{file.name}</span>
              <span className="tabular shrink-0 font-mono text-moss-400">+{file.added}</span>
              <span className="tabular shrink-0 font-mono text-brick-400">−{file.removed}</span>
            </button>
            {!isClosed && (
              <div className="overflow-x-auto border-t border-ink-600/60 font-mono text-xs leading-5">
                <div className="w-max min-w-full py-1">
                  {file.lines.map((line, n) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                    <DiffLine key={n} line={line} />
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** "3 files changed  +12 −4" — the size of a change before anyone reads it. */
function DiffStats({ files }: { files: ParsedDiffFile[] }) {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs text-paper-400">
      <span>{plural(files.length, 'file')} changed</span>
      <span className="tabular font-mono text-moss-400">+{added}</span>
      <span className="tabular font-mono text-brick-400">−{removed}</span>
    </span>
  );
}

export function DiffRenderer({ content }: { content: string }) {
  const [full, setFull] = useState(false);
  const isDiff = isUnifiedDiff(content);
  const files = useMemo(() => (isDiff ? parseUnifiedDiff(content) : []), [content, isDiff]);
  if (!content) {
    return null;
  }

  if (isDiff) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DiffStats files={files} />
          <Button onClick={() => setFull(true)} size="sm" variant="ghost">
            Expand
          </Button>
        </div>
        <DiffBody files={files} maxHeight="max-h-[60vh]" />
        <Modal onClose={() => setFull(false)} open={full} size="full" title="Changes">
          <div className="mb-3">
            <DiffStats files={files} />
          </div>
          <DiffBody files={files} maxHeight="max-h-[74vh]" />
        </Modal>
      </div>
    );
  }

  return (
    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-500/60 bg-ink-950/50 p-3 font-mono text-xs leading-relaxed text-paper-300">
      {content}
    </pre>
  );
}
