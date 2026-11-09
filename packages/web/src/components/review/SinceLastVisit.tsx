'use client';

import type { PullRequestCockpitSinceVisit } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { shortSha } from '@/lib/reviewModel';
import { formatRelativeTime, plural } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';

/** Commit subjects listed before the rest are counted; a long push is not a wall of text. */
const SHOWN = 10;

/**
 * What the head moved through since the reviewer last opened this page. Commit subjects are text a
 * stranger wrote, so each goes through `visibleText` and is rendered as text, never as markup.
 */
export function SinceLastVisit({
  since,
  toHead,
}: {
  since: PullRequestCockpitSinceVisit;
  toHead: string;
}) {
  const commits = since.commits ?? [];
  const more = Math.max(since.totalCommits, commits.length) - Math.min(commits.length, SHOWN);

  let summary: string;
  if (since.commits === null) {
    summary = 'The host could not say which commits came in.';
  } else if (since.rewritten) {
    summary =
      commits.length > 0
        ? 'The branch was rewritten, so the commit you saw is no longer part of it. These are the commits it has now beyond the last one it shares with what you saw:'
        : 'The branch was rewritten, so the commit you saw is no longer part of it.';
  } else {
    summary = `${plural(since.totalCommits, 'commit')} since:`;
  }

  return (
    <Alert announce={false} title="Since you last looked" variant="info">
      <p>
        You last looked {formatRelativeTime(since.lastVisitedAt)}, at{' '}
        <span className="font-mono">{shortSha(since.fromHeadSha)}</span>. It is now at{' '}
        <span className="font-mono">{shortSha(toHead)}</span>. {summary}
      </p>
      {commits.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {commits.slice(0, SHOWN).map((commit) => (
            <li className="break-words" key={commit.sha}>
              <span className="font-mono text-paper-400">{shortSha(commit.sha)}</span>{' '}
              {visibleText(commit.subject)}
            </li>
          ))}
        </ul>
      ) : null}
      {more > 0 ? <p className="mt-1 text-paper-400">and {plural(more, 'more commit')}.</p> : null}
      <p className="mt-2 text-paper-400">
        Files you marked viewed whose patch has changed since are unread again.
      </p>
    </Alert>
  );
}
