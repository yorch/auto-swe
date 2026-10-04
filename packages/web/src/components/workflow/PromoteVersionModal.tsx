'use client';

import Link from 'next/link';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { usePromoteWorkflowVersion, useWorkflowSpecDiff } from '@/hooks/useTemplates';

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
  let summary: string;
  if (activating) {
    summary = `Version ${version} becomes the version new runs use, and the template becomes available to run.`;
  } else if (diff) {
    summary = `+${diff.diff.addedNodes.length} added / −${diff.diff.removedNodes.length} removed / ~${diff.diff.changedNodes.length} changed nodes compared with the active version (v${activeVersion}).`;
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
          <p className="tabular font-mono text-xs text-paper-300">{summary}</p>
          {comparing && !hideDiffLink && (
            <Link
              className="text-sm text-ember-400 hover:underline"
              href={`/workflows/library/${templateId}/diff?a=${activeVersion}&b=${version}`}
            >
              View diff
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
