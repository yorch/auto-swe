import type { PullRequestState } from '@auto-swe/shared/lib/pullRequest';
import { Badge, type BadgeTone } from '@/components/ui/Badge';

/** What a PR is called and coloured: a draft is an open PR not yet asking for review. */
export function pullRequestStateMeta(
  status: PullRequestState,
  isDraft: boolean
): { label: string; tone: BadgeTone } {
  if (status === 'MERGED') {
    return { label: 'Merged', tone: 'violet' };
  }
  if (status === 'CLOSED') {
    return { label: 'Closed', tone: 'brick' };
  }
  return isDraft ? { label: 'Draft', tone: 'neutral' } : { label: 'Open', tone: 'moss' };
}

export function PullRequestStateBadge({
  isDraft,
  status,
}: {
  isDraft: boolean;
  status: PullRequestState;
}) {
  const { label, tone } = pullRequestStateMeta(status, isDraft);
  return (
    <Badge tone={tone} variant="outline">
      {label}
    </Badge>
  );
}

const CI_TONES: Record<string, { label: string; tone: BadgeTone }> = {
  FAILED: { label: 'CI failed', tone: 'brick' },
  PASSED: { label: 'CI passed', tone: 'moss' },
  PENDING: { label: 'CI pending', tone: 'amber' },
};

/** The CI verdict as words, so the colour is never the only signal. */
export function CiBadge({ status }: { status: string }) {
  const { label, tone } = CI_TONES[status] ?? {
    label: `CI ${status.toLowerCase()}`,
    tone: 'neutral',
  };
  return (
    <Badge tone={tone} variant="outline">
      {label}
    </Badge>
  );
}
