'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Icon } from '@/components/ui/Icon';
import { usePromoteWorkflowVersion, useWorkflowSpecDiff } from '@/hooks/useTemplates';

/**
 * The diff page reads lower -> higher by default. Promoting an older version changes the
 * template from the active (higher) one to the older one, so the link opens reversed to
 * match the counts above it.
 */
export function diffHref(templateId: string, activeVersion: number, version: number): string {
  const base = `/workflows/library/${templateId}/diff?a=${activeVersion}&b=${version}`;
  return version < activeVersion ? `${base}&reversed=1` : base;
}

/**
 * Confirms making a version the one new runs use. Shows what changes against the
 * current active version (+ added / − removed / ~ changed nodes) with a link to the full
 * diff. When the version is already the active one (a draft being activated for the
 * first time) there is nothing to compare and the copy says so.
 */
export function PromoteVersionModal({
  activeVersion,
  hideDiffLink = false,
  onClose,
  open,
  templateId,
  version,
}: {
  activeVersion: number | null;
  /** Omit the "View diff" link when the user is already on the diff page. */
  hideDiffLink?: boolean;
  onClose: () => void;
  open: boolean;
  templateId: string;
  version: number;
}) {
  const promote = usePromoteWorkflowVersion(templateId);
  const comparing = open && activeVersion !== null && activeVersion !== version;
  const { data: diff, isLoading } = useWorkflowSpecDiff(
    templateId,
    comparing ? activeVersion : null,
    comparing ? version : null
  );

  const activating = activeVersion === version;
  let summary: React.ReactNode;
  if (activating) {
    summary = `Version ${version} becomes the version new runs use, and the template becomes available to run.`;
  } else if (diff) {
    summary = (
      <span className="flex flex-wrap items-center gap-1.5">
        <span>Compared with v{activeVersion}:</span>
        <Badge tone="moss" variant="outline">
          {diff.diff.addedNodes.length} added
        </Badge>
        <Badge tone="brick" variant="outline">
          {diff.diff.removedNodes.length} removed
        </Badge>
        <Badge tone="amber" variant="outline">
          {diff.diff.changedNodes.length} changed
        </Badge>
      </span>
    );
  } else if (isLoading) {
    summary = 'Comparing with the active version…';
  } else {
    summary = `Compared with the active version (v${activeVersion}) the changes could not be loaded.`;
  }

  return (
    <ConfirmModal
      confirmLabel={activating ? 'Activate' : 'Promote to active'}
      message={
        <div className="space-y-2">
          <p>
            {activating
              ? `Activate version ${version}?`
              : `New runs will use version ${version} instead of version ${activeVersion ?? 'none'}.`}
          </p>
          <div className="text-[13px] text-paper-300">{summary}</div>
          {comparing && !hideDiffLink && (
            <Link
              className="inline-flex items-center gap-1 text-[13px] text-ember-400 hover:underline"
              href={diffHref(templateId, activeVersion, version)}
            >
              View the full diff
              <Icon name="arrowRight" size={13} />
            </Link>
          )}
        </div>
      }
      onClose={onClose}
      onConfirm={async () => {
        await promote.mutateAsync(version);
      }}
      open={open}
      pendingLabel={activating ? 'Activating…' : 'Promoting…'}
      title={activating ? 'Activate this version?' : `Promote v${version} to active?`}
    />
  );
}
