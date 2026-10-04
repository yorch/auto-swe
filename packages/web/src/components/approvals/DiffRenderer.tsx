'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { isUnifiedDiff, type ParsedDiffLine, parseUnifiedDiff } from './diffParse';

const LINE_CLASS: Record<ParsedDiffLine['kind'], string> = {
  add: 'bg-moss-400/10 text-moss-400',
  ctx: 'text-paper-300',
  del: 'bg-brick-400/10 text-brick-400',
  hunk: 'bg-dust-400/5 text-dust-400',
  meta: 'text-paper-600',
};

function DiffLine({ line }: { line: ParsedDiffLine }) {
  return (
    <div className={`flex ${LINE_CLASS[line.kind]}`}>
      <span aria-hidden="true" className="w-10 shrink-0 select-none pr-2 text-right text-paper-600">
        {line.oldNo ?? ''}
      </span>
      <span aria-hidden="true" className="w-10 shrink-0 select-none pr-2 text-right text-paper-600">
        {line.newNo ?? ''}
      </span>
      <span className="whitespace-pre px-1">{line.text || ' '}</span>
    </div>
  );
}

function DiffBody({ content, maxHeight }: { content: string; maxHeight: string }) {
  const files = useMemo(() => parseUnifiedDiff(content), [content]);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return (
    <div className={`${maxHeight} space-y-2 overflow-auto rounded bg-ink-900 p-2`}>
      {files.map((file, i) => {
        const key = `${i}:${file.name}`;
        const isClosed = closed[key] === true;
        return (
          <section className="rounded border border-ink-600" key={key}>
            <button
              aria-expanded={!isClosed}
              className="flex w-full items-center gap-2 bg-ink-800 px-2 py-1.5 text-left text-xs hover:bg-ink-700"
              onClick={() => setClosed((c) => ({ ...c, [key]: !isClosed }))}
              type="button"
            >
              <span aria-hidden="true">{isClosed ? '▸' : '▾'}</span>
              <span className="min-w-0 flex-1 break-all font-mono text-paper-200">{file.name}</span>
              <span className="shrink-0 font-mono text-moss-400">+{file.added}</span>
              <span className="shrink-0 font-mono text-brick-400">−{file.removed}</span>
            </button>
            {!isClosed && (
              <div className="overflow-x-auto font-mono text-xs leading-5">
                <div className="w-max min-w-full">
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

export function DiffRenderer({ content }: { content: string }) {
  const [full, setFull] = useState(false);
  if (!content) {
    return null;
  }

  if (isUnifiedDiff(content)) {
    return (
      <div className="space-y-1">
        <div className="flex justify-end">
          <Button onClick={() => setFull(true)} size="sm" variant="ghost">
            Expand
          </Button>
        </div>
        <DiffBody content={content} maxHeight="max-h-[60vh]" />
        <Modal onClose={() => setFull(false)} open={full} size="lg" title="Changes">
          <DiffBody content={content} maxHeight="max-h-[75vh]" />
        </Modal>
      </div>
    );
  }

  return (
    <pre className="max-h-[60vh] overflow-auto text-xs font-mono text-paper-300 whitespace-pre-wrap break-words">
      {content}
    </pre>
  );
}
