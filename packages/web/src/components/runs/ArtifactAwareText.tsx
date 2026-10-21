'use client';

import { Fragment, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { ExpandablePre } from '@/components/ui/ExpandablePre';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useContextArtifact } from '@/hooks/useRuns';

// The placeholder the worker writes for a context value it spilled to an artifact
// (workflows/runnableContext.ts, pinned by runnableContext.test.ts). The separator is an em dash.
const MARKER_SOURCE =
  '\\[stored as artifact ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) — (\\d+) bytes\\]';

export type ArtifactTextPart =
  | { kind: 'text'; value: string }
  | { kind: 'marker'; artifactId: string; sizeBytes: number };

/** Splits `text` into plain runs and the spill markers between them. */
export function splitArtifactMarkers(text: string): ArtifactTextPart[] {
  const parts: ArtifactTextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(MARKER_SOURCE, 'g'))) {
    if (m.index > last) {
      parts.push({ kind: 'text', value: text.slice(last, m.index) });
    }
    parts.push({ artifactId: m[1], kind: 'marker', sizeBytes: Number(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < text.length || parts.length === 0) {
    parts.push({ kind: 'text', value: text.slice(last) });
  }
  return parts;
}

/** Mounted only while the modal is open, so the read starts on open and not before. */
function ArtifactBody({ artifactId, runId }: { artifactId: string; runId: string }) {
  const query = useContextArtifact(runId, artifactId, true);
  return (
    <QueryBoundary
      error={query.error}
      isError={query.isError}
      isFetching={query.isFetching}
      isLoading={query.isLoading}
      label="the full text"
      onRetry={() => query.refetch()}
      shape="detail"
    >
      {query.data && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <CopyButton value={query.data.text} />
          </div>
          <ExpandablePre
            className="whitespace-pre-wrap break-words rounded-md border border-ink-500/50 bg-ink-950/60 p-3 font-mono text-xs leading-relaxed text-paper-300"
            collapsedHeight="28rem"
          >
            {query.data.text}
          </ExpandablePre>
        </div>
      )}
    </QueryBoundary>
  );
}

/**
 * A run's text, with each "[stored as artifact …]" placeholder turned into a button that
 * opens the full text. The stored text is the run's own output, so it is rendered as text
 * (a React text node), never as HTML.
 */
export function ArtifactAwareText({ runId, text }: { runId: string; text: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const parts = splitArtifactMarkers(text);
  if (parts.length === 1 && parts[0].kind === 'text') {
    return <>{text}</>;
  }
  // Parts are positional and never reorder; the same artifact may appear twice, so the id is no key.
  let position = 0;
  return (
    <>
      {parts.map((part) => {
        const key = position++;
        return part.kind === 'text' ? (
          <Fragment key={key}>{part.value}</Fragment>
        ) : (
          <Button
            key={key}
            onClick={() => setOpenId(part.artifactId)}
            size="sm"
            type="button"
            variant="secondary"
          >
            View full text ({part.sizeBytes.toLocaleString('en-US')} bytes)
          </Button>
        );
      })}
      <Modal onClose={() => setOpenId(null)} open={openId !== null} size="lg" title="Full text">
        {openId && <ArtifactBody artifactId={openId} runId={runId} />}
        <ModalFooter cancelLabel="Close" onCancel={() => setOpenId(null)} />
      </Modal>
    </>
  );
}
