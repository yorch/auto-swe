'use client';

import type { RunEvidenceDto } from '@auto-swe/shared/types/api';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { useRunEvidence, useRunEvidenceLink } from '@/hooks/useRunEvidence';
import { API_BASE } from '@/lib/config';

function downloadUrl(url: string) {
  const link = document.createElement('a');
  link.href = `${API_BASE}${url}`;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function EvidenceCard({ evidence, runId }: { evidence: RunEvidenceDto; runId: string }) {
  const [visible, setVisible] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [refreshUsed, setRefreshUsed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const link = useRunEvidenceLink(runId, evidence.id, visible);
  const media = evidence.kind === 'screenshot' || evidence.kind === 'video';

  useEffect(() => {
    const element = container.current;
    if (!element) {
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '150px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const refreshOnMediaError = () => {
    if (!refreshUsed) {
      setRefreshUsed(true);
      void link.refetch();
    }
  };

  const download = async () => {
    const result = await link.refetch();
    if (result.data) {
      downloadUrl(result.data.url);
    }
  };

  return (
    <div className="rounded border border-ink-700 p-3" ref={container}>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-paper-200">{evidence.caption || evidence.kind}</p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-paper-500">
            {evidence.pageUrl && <span className="max-w-full break-all">{evidence.pageUrl}</span>}
            {evidence.specNodeId && <span>Node {evidence.specNodeId}</span>}
            {evidence.stepAttempt !== null && <span>Attempt {evidence.stepAttempt}</span>}
            <span>Source: {evidence.source}</span>
          </div>
        </div>
        {!media && (
          <Button onClick={() => void download()} size="sm" variant="secondary">
            Download {evidence.kind}
          </Button>
        )}
      </div>
      {media && link.data && evidence.kind === 'screenshot' && (
        <button
          aria-label={`Open screenshot: ${evidence.caption || evidence.id}`}
          className="block max-w-full cursor-zoom-in"
          onClick={() => setLightboxOpen(true)}
          type="button"
        >
          <Image
            alt={evidence.caption || 'Run screenshot'}
            className="max-h-96 max-w-full rounded object-contain"
            height={evidence.height || 800}
            onError={refreshOnMediaError}
            src={`${API_BASE}${link.data.url}`}
            unoptimized
            width={evidence.width || 1280}
          />
        </button>
      )}
      {media && link.data && evidence.kind === 'video' && (
        <video
          className="max-h-96 max-w-full rounded"
          controls
          onError={refreshOnMediaError}
          preload="metadata"
          src={`${API_BASE}${link.data.url}`}
        >
          <track
            default
            kind="captions"
            label="No captions available"
            src="data:text/vtt,WEBVTT%0A%0A"
            srcLang="en"
          />
        </video>
      )}
      {evidence.kind === 'trace' && (
        <p className="text-xs text-paper-500">
          Open with <code>npx playwright show-trace &lt;file&gt;</code>
        </p>
      )}
      {media && !link.data && !link.isError && (
        <p className="text-xs text-paper-500">Loading preview…</p>
      )}
      {media && link.isError && (
        <p className="text-xs text-danger-400">Could not load this evidence.</p>
      )}
      {evidence.kind === 'screenshot' && link.data && (
        <Modal
          onClose={() => setLightboxOpen(false)}
          open={lightboxOpen}
          size="full"
          title={evidence.caption || 'Run screenshot'}
        >
          <Image
            alt={evidence.caption || 'Run screenshot'}
            className="mx-auto max-h-[75vh] max-w-full object-contain"
            height={evidence.height || 800}
            onError={refreshOnMediaError}
            src={`${API_BASE}${link.data.url}`}
            unoptimized
            width={evidence.width || 1280}
          />
          <ModalFooter cancelLabel="Close" onCancel={() => setLightboxOpen(false)} />
        </Modal>
      )}
    </div>
  );
}

export function RunEvidence({ runId, live }: { runId: string; live: boolean }) {
  const { data } = useRunEvidence(runId, live);
  if (!data || data.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Run evidence"
      className="rounded border border-ink-700 px-4 py-3"
      id="evidence"
    >
      <h2 className="mb-3 text-sm font-medium text-paper-300">Evidence</h2>
      <div className="grid gap-3 md:grid-cols-2">
        {data.map((item) => (
          <EvidenceCard evidence={item} key={item.id} runId={runId} />
        ))}
      </div>
    </section>
  );
}
