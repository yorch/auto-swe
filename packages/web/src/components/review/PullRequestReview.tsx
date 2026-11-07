'use client';

import type { PullRequestCockpit, PullRequestCockpitFile } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { parseFilePatch } from '@/components/approvals/diffParse';
import { DiffFile } from '@/components/diff/DiffFile';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { CiBadge, PullRequestStateBadge } from '@/components/work/PullRequestBadges';
import { useSetFilesViewed } from '@/hooks/usePullRequestCockpit';
import {
  type FileFilter,
  filesUnavailableMessage,
  filterFiles,
  findingCounts,
  findingsByLine,
  shortSha,
  unanchoredFindings,
  viewedProgress,
} from '@/lib/reviewModel';
import { safeHttpUrl } from '@/lib/safeUrl';
import { cn, FOCUS_RING, plural } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';
import { FindingNote } from './FindingNote';
import { ReviewBrief } from './ReviewBrief';

/** Files open when the page loads; the rest wait to be opened, so a big change draws a few. */
const OPEN_BY_DEFAULT = 3;

const RISK_TONES: Record<string, BadgeTone> = {
  HIGH: 'danger',
  LOW: 'success',
  STANDARD: 'warning',
};

const FILTERS: { label: string; value: FileFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'To verify', value: 'verify' },
  { label: 'Unviewed', value: 'unviewed' },
  { label: 'Skim', value: 'skim' },
];

const fileAnchor = (index: number) => `review-file-${index}`;

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    element !== null &&
    (element.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName))
  );
}

/** A file with nothing to draw: a binary file, or a patch the platform does not carry. */
function NoPatch({ anchorId, file }: { anchorId: string; file: PullRequestCockpitFile }) {
  return (
    <section
      className="rounded-lg border border-ink-500/60 bg-ink-950/50 px-3 py-2 text-xs"
      id={anchorId}
    >
      <span className="break-all font-mono text-paper-100">{visibleText(file.path)}</span>
      <span className="ml-2 text-paper-400">
        No patch to show: a binary file, or one too large. Open it on the host.
      </span>
    </section>
  );
}

export function PullRequestReview({ data }: { data: PullRequestCockpit }) {
  const { evaluation, files, pull } = data;
  const setViewed = useSetFilesViewed(pull.id);
  const items = useMemo(() => (files.type === 'ok' ? files.items : []), [files]);
  const viewed = useMemo(() => new Set(data.viewed), [data.viewed]);
  const findings = evaluation?.findings ?? [];

  const [filter, setFilter] = useState<FileFilter>('all');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);

  const indexOf = useMemo(() => new Map(items.map((f, i) => [f.path, i])), [items]);
  const parsed = useMemo(
    () => new Map(items.map((f) => [f.path, f.patch === null ? null : parseFilePatch(f.patch)])),
    [items]
  );
  const annotations = useMemo(() => {
    const byFile = new Map<string, Map<number, ReactNode>>();
    for (const file of items) {
      const lines = findingsByLine(findings, file.path);
      if (lines.size > 0) {
        byFile.set(
          file.path,
          new Map(
            [...lines].map(([line, here]) => [
              line,
              <div className="space-y-2" key={line}>
                {here.map((finding, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: findings have no id
                  <FindingNote finding={finding} key={n} />
                ))}
              </div>,
            ])
          )
        );
      }
    }
    return byFile;
  }, [items, findings]);
  const counts = useMemo(() => findingCounts(findings), [findings]);
  const unplaced = useMemo(() => unanchoredFindings(findings), [findings]);

  const shown = useMemo(() => filterFiles(items, viewed, filter), [items, viewed, filter]);
  const progress = viewedProgress(items, viewed);
  const isOpen = useCallback(
    (path: string) => open[path] ?? (indexOf.get(path) ?? 0) < OPEN_BY_DEFAULT,
    [open, indexOf]
  );

  const select = useCallback(
    (path: string) => {
      setSelected(path);
      setOpen((current) => ({ ...current, [path]: true }));
      const index = indexOf.get(path);
      if (index !== undefined) {
        // After the body has drawn, so the file lands where its header was.
        requestAnimationFrame(() =>
          document.getElementById(fileAnchor(index))?.scrollIntoView?.({ block: 'start' })
        );
      }
    },
    [indexOf]
  );

  const toggleViewed = useCallback(
    (file: PullRequestCockpitFile) => {
      if (file.patchDigest === null) {
        return;
      }
      const next = !viewed.has(file.path);
      setViewed.mutate({
        files: [{ patchDigest: file.patchDigest, path: file.path }],
        viewed: next,
      });
      if (next) {
        // A file that has been read gets out of the way.
        setOpen((current) => ({ ...current, [file.path]: false }));
      }
    },
    [viewed, setViewed]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
        return;
      }
      if (event.key === 'j' || event.key === 'k') {
        const at = selected === null ? -1 : shown.findIndex((f) => f.path === selected);
        const next =
          shown[event.key === 'j' ? Math.min(at + 1, shown.length - 1) : Math.max(at - 1, 0)];
        if (next) {
          select(next.path);
        }
      } else if (event.key === 'v' && selected !== null) {
        const file = items.find((f) => f.path === selected);
        if (file) {
          toggleViewed(file);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, select, selected, shown, toggleViewed]);

  const hostUrl = safeHttpUrl(pull.url);
  const added = items.reduce((n, f) => n + f.additions, 0);
  const removed = items.reduce((n, f) => n + f.deletions, 0);
  const reviewedHead = files.type === 'ok' ? files.headSha : pull.headSha;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h1 className="break-words text-2xl font-semibold leading-tight tracking-[-0.02em] text-paper-50">
            {pull.prNumber !== null ? `#${pull.prNumber} ` : ''}
            {visibleText(pull.title ?? 'Pull request')}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-paper-400">
            <PullRequestStateBadge isDraft={pull.isDraft} status={pull.status} />
            <CiBadge status={pull.ciStatus} />
            {evaluation ? (
              <Badge tone={RISK_TONES[evaluation.riskClass] ?? 'neutral'} variant="outline">
                {evaluation.riskClass === 'HIGH'
                  ? 'High risk'
                  : evaluation.riskClass === 'LOW'
                    ? 'Low risk'
                    : 'Standard risk'}
              </Badge>
            ) : null}
            {pull.repository ? (
              <span className="font-mono">
                {visibleText(pull.repository.org)}/{visibleText(pull.repository.name)}
              </span>
            ) : null}
            <span className="font-mono" title={reviewedHead}>
              {shortSha(reviewedHead)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pull.latestRun ? (
            <ButtonLink href={`/runs/${pull.latestRun.id}`} size="sm" variant="ghost">
              Run
            </ButtonLink>
          ) : null}
          {hostUrl ? (
            <a
              className={cn(FOCUS_RING, 'rounded-sm text-sm text-accent-400 hover:underline')}
              href={hostUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open on the host
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </header>

      {evaluation?.stale ? (
        <Alert title="The review covers an earlier commit" variant="warning">
          It was made at {shortSha(evaluation.headSha)} and the pull request is now at{' '}
          {shortSha(reviewedHead)}. Its findings are listed without their lines, and the evidence
          below describes the earlier commit.
        </Alert>
      ) : null}
      {files.type === 'unavailable' ? (
        <Alert title="The changed files are not available" variant="warning">
          {filesUnavailableMessage(files.reason)}
          {hostUrl ? ' You can still review on the host.' : ''}
        </Alert>
      ) : null}
      {files.type === 'ok' && files.truncated ? (
        <Alert variant="warning">
          The host lists more files than are shown here. Review the rest on the host.
        </Alert>
      ) : null}
      {files.type === 'ok' && files.state !== 'open' ? (
        <Alert announce={false} variant="info">
          This pull request is {files.state} on the host.
        </Alert>
      ) : null}

      <ReviewBrief evaluation={evaluation} pull={pull} />

      {unplaced.length > 0 ? (
        <Card className="space-y-3 p-5" variant="inset">
          <h2 className="text-sm font-semibold text-paper-100">
            {plural(unplaced.length, 'finding')} not tied to a line
          </h2>
          {unplaced.map((finding, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: findings have no id
            <FindingNote finding={finding} key={n} showLocation />
          ))}
        </Card>
      ) : null}

      {files.type === 'ok' ? (
        <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav
            aria-label="Changed files"
            className="min-w-0 space-y-3 lg:sticky lg:top-4 lg:self-start"
          >
            <div className="space-y-1 text-xs text-paper-400">
              <p>
                {plural(items.length, 'file')} · <span className="text-success-400">+{added}</span>{' '}
                <span className="text-danger-400">−{removed}</span>
              </p>
              <p aria-live="polite">
                {progress.done} of {progress.total} viewed
              </p>
            </div>
            <SegmentedControl
              ariaLabel="Filter files"
              onChange={setFilter}
              options={FILTERS}
              value={filter}
            />
            <ul className="max-h-[60vh] space-y-0.5 overflow-auto">
              {shown.map((file) => (
                <li key={file.path}>
                  <button
                    aria-current={selected === file.path}
                    className={cn(
                      FOCUS_RING,
                      'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-ink-700',
                      selected === file.path && 'bg-ink-700'
                    )}
                    onClick={() => select(file.path)}
                    type="button"
                  >
                    <span className="mt-0.5 w-3.5 shrink-0">
                      {viewed.has(file.path) ? (
                        <>
                          <Icon className="text-success-400" name="checkCircle" size={13} />
                          <span className="sr-only">Viewed</span>
                        </>
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 break-all font-mono text-paper-200">
                      {visibleText(file.path)}
                    </span>
                    {file.flagged ? (
                      <span className="shrink-0 text-warning-400">
                        <span aria-hidden="true">⚑</span>
                        <span className="sr-only">To verify</span>
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
              {shown.length === 0 ? (
                <li className="px-2 py-1.5 text-xs text-paper-500">No files match this filter.</li>
              ) : null}
            </ul>
            <p className="text-xs text-paper-500">
              Keys: <kbd>j</kbd> and <kbd>k</kbd> move between files, <kbd>v</kbd> marks one viewed.
            </p>
          </nav>

          <div className="min-w-0 space-y-3">
            {items.length === 0 ? (
              <Alert announce={false} variant="info">
                The host lists no changed files for this pull request.
              </Alert>
            ) : null}
            {items.map((file, index) => {
              if (!shown.some((f) => f.path === file.path)) {
                return null;
              }
              const lines = parsed.get(file.path);
              const here = counts.get(file.path) ?? 0;
              return (
                <div className="space-y-1" key={file.path}>
                  {file.flagged && file.why ? (
                    <p className="text-xs text-paper-400">
                      <span className="text-warning-400">To verify:</span>{' '}
                      {visibleText(file.why, { multiline: true })}
                      {file.verify ? ` ${visibleText(file.verify, { multiline: true })}` : ''}
                    </p>
                  ) : null}
                  {lines ? (
                    <DiffFile
                      added={lines.added}
                      anchorId={fileAnchor(index)}
                      annotations={annotations.get(file.path)}
                      headerExtra={
                        <span className="flex items-center gap-2">
                          {here > 0 ? (
                            <Badge tone="warning" variant="outline">
                              {plural(here, 'finding')}
                            </Badge>
                          ) : null}
                          {file.skim ? (
                            <Badge tone="neutral" variant="outline">
                              Skim
                            </Badge>
                          ) : null}
                          <label className="flex items-center gap-1.5 text-xs text-paper-300">
                            <input
                              checked={viewed.has(file.path)}
                              disabled={file.patchDigest === null}
                              onChange={() => toggleViewed(file)}
                              type="checkbox"
                            />
                            Viewed
                          </label>
                        </span>
                      }
                      lines={lines.lines}
                      name={file.path}
                      onToggle={() => setOpen((c) => ({ ...c, [file.path]: !isOpen(file.path) }))}
                      open={isOpen(file.path)}
                      previousName={file.previousPath}
                      removed={lines.removed}
                    />
                  ) : (
                    <NoPatch anchorId={fileAnchor(index)} file={file} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {pull.ticketId && pull.workRequestId ? (
        <p className="text-xs text-paper-500">
          From{' '}
          <Link
            className="text-accent-400 hover:underline"
            href={`/requests/${pull.workRequestId}`}
          >
            {visibleText(pull.ticketId)}
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
