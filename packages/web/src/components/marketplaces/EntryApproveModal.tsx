'use client';

import { useEffect, useRef, useState } from 'react';
import { HooksChoice } from '@/components/harnessProfiles/HooksChoice';
import { ProfilePreview } from '@/components/harnessProfiles/ProfilePreview';
import { ProjectionResult } from '@/components/harnessProfiles/ProjectionResult';
import {
  describeProfileError,
  keyed,
  locationLabel,
  type ProfileError,
  shortSha,
} from '@/components/harnessProfiles/profileDisplay';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import {
  type EntryApproveResult,
  type EntryPreview,
  useApproveEntry,
  usePreviewEntry,
} from '@/hooks/useMarketplaces';
import { visibleText } from '@/lib/visibleText';
import { McpServersList } from './McpServersList';

/**
 * Approve one marketplace entry as a plugin: preview it (reads, validates and scans; writes
 * nothing), read the files, choose the hook switch, acknowledge any warnings, approve. The
 * approval names the previewed commit, `contentHash` and `warningsHash`; if any moved since,
 * the answer is a 409 and a fresh preview is offered.
 */
export function EntryApproveModal({
  entry,
  marketplaceId,
  onClose,
}: {
  marketplaceId: string;
  /** The entry's name; null closes the dialog. */
  entry: string | null;
  onClose: () => void;
}) {
  const preview = usePreviewEntry();
  const approve = useApproveEntry();
  const [previewed, setPreviewed] = useState<EntryPreview | null>(null);
  const [hooksEnabled, setHooksEnabled] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [hooksConfirmed, setHooksConfirmed] = useState(false);
  const [error, setError] = useState<ProfileError | null>(null);
  const [done, setDone] = useState<EntryApproveResult | null>(null);

  const load = useRef(async (_name: string) => {});
  load.current = async (name: string) => {
    setError(null);
    setAcknowledged(false);
    setHooksConfirmed(false);
    setPreviewed(null);
    try {
      setPreviewed(await preview.mutateAsync({ entry: name, id: marketplaceId }));
    } catch (err) {
      setError(describeProfileError(err, 'Failed to read the plugin'));
    }
  };

  // Reading starts when an entry is chosen; a different entry starts clean.
  useEffect(() => {
    setDone(null);
    setHooksEnabled(false);
    setHooksConfirmed(false);
    setPreviewed(null);
    setError(null);
    if (entry !== null) {
      void load.current(entry);
    }
  }, [entry]);

  async function runApprove() {
    if (!previewed || entry === null) {
      return;
    }
    setError(null);
    try {
      setDone(
        await approve.mutateAsync({
          acknowledgeWarnings: acknowledged,
          contentHash: previewed.contentHash,
          entry,
          hooksEnabled,
          id: marketplaceId,
          sha: previewed.sha,
          warningsHash: previewed.warningsHash,
        })
      );
    } catch (err) {
      setError(describeProfileError(err, 'Failed to approve the plugin'));
    }
  }

  const name = entry === null ? '' : visibleText(entry);
  const needsAck = (previewed?.warnings.length ?? 0) > 0;
  const conflicts = previewed?.conflicts ?? [];

  const errorAlert = error && (
    <Alert>
      {error.message}
      {error.lines.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {keyed(error.lines).map((l) => (
            <li key={l.key}>{l.text}</li>
          ))}
        </ul>
      )}
      {error.stale && entry !== null && (
        <div className="mt-2">
          <Button disabled={preview.isPending} onClick={() => void load.current(entry)} size="sm">
            Preview again
          </Button>
        </div>
      )}
    </Alert>
  );

  return (
    <Modal
      onClose={onClose}
      open={entry !== null}
      size="lg"
      subtitle={
        previewed ? `${locationLabel(previewed.source)} @ ${shortSha(previewed.sha)}` : undefined
      }
      title={done ? 'Plugin approved' : `Approve "${name}"`}
    >
      {done ? (
        <div className="space-y-4">
          <Alert announce={false} variant="success">
            “{visibleText(done.name)}” was approved as version {done.version} with hooks{' '}
            {done.hooksEnabled ? 'on' : 'off'}. A team enables it before its agents can use it.
          </Alert>
          <ProjectionResult projection={done.projection} />
          <ModalFooter cancelLabel="Close" onCancel={onClose} />
        </div>
      ) : (
        <div className="space-y-4">
          {!previewed && preview.isPending && (
            <p className="text-sm text-paper-400">Reading the plugin…</p>
          )}
          {previewed && (
            <>
              <p className="text-xs text-paper-500">
                Nothing has been written yet. Hooks and scripts in a plugin run commands inside the
                run container, so check the file list and warnings below, and read the files at the
                commit shown, before approving. Everything below comes from the repository.
              </p>
              <ProfilePreview
                key={`${previewed.sha}:${previewed.contentHash}`}
                preview={previewed}
              />
              <section aria-label="MCP servers" className="space-y-2">
                <h3 className="text-sm font-semibold text-paper-100">MCP servers</h3>
                <McpServersList servers={previewed.mcpServers} />
              </section>
              <div className="flex items-center gap-2 text-sm text-paper-300">
                <span>Hook files:</span>
                <Badge dot tone={previewed.hasHooks ? 'warning' : 'neutral'}>
                  {previewed.hasHooks ? 'The plugin declares hooks' : 'No hooks declared'}
                </Badge>
              </div>
              {conflicts.length > 0 && (
                <Alert variant="error">
                  A plugin named{' '}
                  {conflicts
                    .map((c) => `${visibleText(c.name)} (${c.status.toLowerCase()})`)
                    .join(', ')}{' '}
                  already exists. Names are compared case-insensitively and cannot be reused.
                </Alert>
              )}
              <HooksChoice
                hooksConfirmed={hooksConfirmed}
                name="entry-approve-hooks"
                onChange={setHooksEnabled}
                onConfirmedChange={setHooksConfirmed}
                value={hooksEnabled}
              />
              {needsAck && (
                <Checkbox
                  checked={acknowledged}
                  label={`I have read the ${previewed.warnings.length} warning(s) and the files, and approve this plugin anyway`}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
              )}
            </>
          )}
          {errorAlert}
          <ModalFooter
            disabled={
              !previewed ||
              conflicts.length > 0 ||
              (needsAck && !acknowledged) ||
              (hooksEnabled && !hooksConfirmed)
            }
            isPending={approve.isPending}
            onCancel={onClose}
            onSubmit={runApprove}
            pendingLabel="Approving…"
            submitLabel="Approve plugin"
          />
        </div>
      )}
    </Modal>
  );
}
