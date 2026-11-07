'use client';

import { useMemo, useState } from 'react';
import { DiffFile } from '@/components/diff/DiffFile';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { cn, plural } from '@/lib/utils';
import { isUnifiedDiff, type ParsedDiffFile, parseUnifiedDiff } from './diffParse';

function DiffBody({ files, maxHeight }: { files: ParsedDiffFile[]; maxHeight: string }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return (
    <div className={cn(maxHeight, 'space-y-2 overflow-auto')}>
      {files.map((file, i) => {
        const key = `${i}:${file.name}`;
        return (
          <DiffFile
            added={file.added}
            key={key}
            lines={file.lines}
            name={file.name}
            onToggle={() => setClosed((c) => ({ ...c, [key]: c[key] !== true }))}
            open={closed[key] !== true}
            removed={file.removed}
          />
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
      <span className="tabular font-mono text-success-400">+{added}</span>
      <span className="tabular font-mono text-danger-400">−{removed}</span>
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
