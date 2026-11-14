'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Modal } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type HarnessProfileDetail,
  type HarnessProfilePreview,
  useAcceptProfileVersion,
  useHarnessProfile,
  usePreviewProfileUpdate,
  useReviewUpdateFile,
} from '@/hooks/useHarnessProfiles';
import { formatDate } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';
import { ProfilePreview } from './ProfilePreview';
import {
  describeProfileError,
  formatBytes,
  keyed,
  locationLabel,
  type ProfileError,
  shortSha,
} from './profileDisplay';

function UpdateReview({ profile }: { profile: HarnessProfileDetail }) {
  const check = usePreviewProfileUpdate();
  const reviewFile = useReviewUpdateFile();
  const accept = useAcceptProfileVersion();
  const [previewed, setPreviewed] = useState<HarnessProfilePreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<ProfileError | null>(null);
  const [accepted, setAccepted] = useState<number | null>(null);
  const disabled = profile.status === 'DISABLED';

  async function runCheck() {
    setError(null);
    setAccepted(null);
    setAcknowledged(false);
    try {
      setPreviewed(await check.mutateAsync({ name: profile.name }));
    } catch (err) {
      setPreviewed(null);
      setError(describeProfileError(err, 'Failed to check for an update'));
    }
  }

  async function runAccept() {
    if (!previewed) {
      return;
    }
    setError(null);
    try {
      const v = await accept.mutateAsync({
        acknowledgeWarnings: acknowledged,
        contentHash: previewed.contentHash,
        name: profile.name,
        sha: previewed.sha,
        warningsHash: previewed.warningsHash,
      });
      setAccepted(v.version);
      setPreviewed(null);
    } catch (err) {
      setError(describeProfileError(err, 'Failed to accept the update'));
    }
  }

  const needsAck = (previewed?.warnings.length ?? 0) > 0;
  const same = previewed?.matchesVersion ?? null;

  return (
    <section aria-label="Check for update" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-paper-100">Update</h3>
        <Button disabled={check.isPending} onClick={runCheck} size="sm">
          {check.isPending ? 'Reading…' : 'Check for update'}
        </Button>
        <span className="text-xs text-paper-500">
          Reads {locationLabel(profile)} at ref {visibleText(profile.ref)} again. Nothing is written
          until you accept.
        </span>
      </div>
      {accepted !== null && (
        <Alert variant="success">Version {accepted} was added. New runs pick it up.</Alert>
      )}
      {error && (
        <Alert>
          {error.message}
          {error.lines.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {keyed(error.lines).map((l) => (
                <li key={l.key}>{l.text}</li>
              ))}
            </ul>
          )}
          {error.stale && (
            <div className="mt-2">
              <Button disabled={check.isPending} onClick={runCheck} size="sm">
                Check again
              </Button>
            </div>
          )}
        </Alert>
      )}
      {previewed && (
        <div className="space-y-3 rounded-md border border-ink-600 p-3">
          {same !== null ? (
            <Alert announce={false} variant="info">
              This content already is version {same}. There is nothing to accept.
            </Alert>
          ) : (
            <Alert announce={false} variant="warning">
              The folder differs from every stored version. Read what changed in the files below,
              then accept it as version {profile.latestVersion + 1}.
            </Alert>
          )}
          <ProfilePreview
            key={`${previewed.sha}:${previewed.contentHash}`}
            onReadFile={(file) =>
              reviewFile.mutateAsync({ file, name: profile.name, sha: previewed.sha })
            }
            preview={previewed}
          />
          {disabled && (
            <Alert variant="warning">
              This profile is disabled; re-enable it before accepting.
            </Alert>
          )}
          {needsAck && same === null && (
            <Checkbox
              checked={acknowledged}
              label={`I have read the ${previewed.warnings.length} warning(s) and the files, and approve this version anyway`}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
          )}
          <Button
            disabled={disabled || same !== null || (needsAck && !acknowledged) || accept.isPending}
            onClick={runAccept}
            variant="primary"
          >
            {accept.isPending ? 'Accepting…' : `Accept as version ${profile.latestVersion + 1}`}
          </Button>
        </div>
      )}
    </section>
  );
}

function Versions({ profile }: { profile: HarnessProfileDetail }) {
  return (
    <section aria-label="Versions" className="space-y-2">
      <h3 className="text-sm font-semibold text-paper-100">Versions</h3>
      <p className="text-xs text-paper-500">
        Versions are immutable snapshots. File lists are shown here; a file's content is read from a
        preview when you add or update a profile.
      </p>
      <Table>
        <THead>
          <Th variant="compact">Version</Th>
          <Th variant="compact">Commit</Th>
          <Th variant="compact">Files</Th>
          <Th variant="compact">Warnings</Th>
          <Th variant="compact">Approved</Th>
        </THead>
        <tbody>
          {profile.versions.map((v) => (
            <TRow key={v.version}>
              <Td className="py-2 pr-4 align-top">
                <div className="font-medium text-paper-100">v{v.version}</div>
                {v.version === profile.latestVersion && <Badge tone="success">latest</Badge>}
                <details className="mt-1 text-xs text-paper-400">
                  <summary className="cursor-pointer">Files</summary>
                  <ul className="mt-1 space-y-0.5 font-mono">
                    {v.files.map((f) => (
                      <li className="break-all" key={f.path}>
                        {visibleText(f.path)} · {formatBytes(f.size)}
                        {f.mode === '100755' ? ' · executable' : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              </Td>
              <Td className="py-2 pr-4 align-top font-mono text-xs text-paper-300">
                <span title={v.commitSha}>{shortSha(v.commitSha)}</span>
                <div className="text-paper-500" title={v.contentHash}>
                  {shortSha(v.contentHash)}
                </div>
              </Td>
              <Td className="py-2 pr-4 align-top tabular-nums text-paper-400">
                {v.fileCount} · {formatBytes(v.totalBytes)}
              </Td>
              <Td className="py-2 pr-4 align-top">
                {v.warnings.length === 0 ? (
                  <span className="text-xs text-paper-500">none</span>
                ) : (
                  <details className="text-xs text-warning-400">
                    <summary className="cursor-pointer">{v.warnings.length} acknowledged</summary>
                    <ul className="mt-1 list-disc pl-4">
                      {keyed(v.warnings).map((w) => (
                        <li key={w.key}>{visibleText(w.text)}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </Td>
              <Td className="py-2 align-top text-xs text-paper-400">{formatDate(v.createdAt)}</Td>
            </TRow>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

/** One profile: its source, every version with its file list, and the update flow. */
export function ProfileDetailModal({
  name,
  onClose,
}: {
  name: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError, isFetching, error, refetch } = useHarnessProfile(name);
  return (
    <Modal
      onClose={onClose}
      open={name !== null}
      size="lg"
      subtitle={data ? visibleText(data.description) : undefined}
      title={name ? visibleText(name) : 'Harness profile'}
    >
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="harness profile"
        onRetry={() => void refetch()}
        rows={3}
      >
        {data && (
          <div className="space-y-6">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-paper-500">Source</dt>
              <dd className="font-mono text-xs text-paper-300 break-all">
                {locationLabel(data)} @ {visibleText(data.ref)}
              </dd>
              <dt className="text-paper-500">Status</dt>
              <dd>
                <Badge dot tone={data.status === 'OK' ? 'success' : 'muted'}>
                  {data.status === 'OK' ? 'Enabled' : 'Disabled'}
                </Badge>
              </dd>
            </dl>
            <UpdateReview profile={data} />
            <Versions profile={data} />
          </div>
        )}
      </QueryBoundary>
    </Modal>
  );
}
