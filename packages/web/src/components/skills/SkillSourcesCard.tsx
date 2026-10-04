'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type DiffChangedSkill,
  type SkillSourceRow,
  type SkillSourceStatus,
  useAcceptSkillUpdate,
  useCheckSkillSource,
  useDeleteSkillSource,
  useSkillSourceDiff,
  useSkillSources,
} from '@/hooks/useSkillSources';
import { errMsg } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/utils';

const STATUS: Record<SkillSourceStatus, { label: string; tone: BadgeTone }> = {
  DISABLED: { label: 'Disabled', tone: 'muted' },
  ERROR: { label: "Couldn't check", tone: 'brick' },
  OK: { label: 'Up to date', tone: 'moss' },
  UPDATE_AVAILABLE: { label: 'Update available', tone: 'amber' },
};

function describe(s: SkillSourceRow) {
  return `${s.owner}/${s.repo}${s.path ? `/${s.path}` : ''}`;
}

/** A unified diff, with added and removed lines coloured. */
function DiffText({ text }: { text: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-[9px] border border-ink-600 bg-ink-900 p-3 text-xs">
      {text.split('\n').map((line, i) => {
        const tone = line.startsWith('+')
          ? 'text-moss-400'
          : line.startsWith('-')
            ? 'text-brick-400'
            : 'text-paper-400';
        // Diff lines have no stable identity; their position in this fixed text is the key.
        // biome-ignore lint/suspicious/noArrayIndexKey: static list
        return (
          <div className={`whitespace-pre-wrap break-words ${tone}`} key={i}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function ChangedSkill({
  checked,
  onToggle,
  skill,
}: {
  checked: boolean;
  onToggle: () => void;
  skill: DiffChangedSkill;
}) {
  const unreadable = skill.diffIncomplete;
  return (
    <li className="space-y-2 rounded-[9px] border border-ink-600 p-3">
      <Checkbox
        checked={checked}
        disabled={unreadable || skill.blockedByScan}
        label={<span className="font-medium text-paper-100">{skill.name}</span>}
        onChange={onToggle}
      />
      {skill.handEdited && (
        <Alert variant="warning">
          This skill was edited here since it was imported. Accepting the update replaces your edits
          with the upstream text.
        </Alert>
      )}
      {unreadable && (
        <Alert variant="warning">
          The change is too large to show in full here, so it can't be accepted from the dashboard.
          Review and accept it with the CLI (skills sources diff, then accept).
        </Alert>
      )}
      {skill.blockedByScan && (
        <Alert variant="error">
          The scanner flagged the new text, and imports are set to refuse flagged skills.
        </Alert>
      )}
      {skill.renamedTo && (
        <p className="text-xs text-paper-400">
          Upstream now calls it "{skill.renamedTo}". The name stays "{skill.name}" here.
        </p>
      )}
      {skill.description.changed && (
        <p className="text-xs text-paper-400">
          Description: "{skill.description.old ?? 'none'}" becomes "
          {skill.description.new ?? 'none'}"
        </p>
      )}
      {skill.scanWarnings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-400">
          {skill.scanWarnings.map((w) => (
            <li key={w}>Scanner: {w}</li>
          ))}
        </ul>
      )}
      {skill.textDiff && !unreadable && <DiffText text={skill.textDiff} />}
      {skill.textDiffTruncated && !unreadable && (
        <p className="text-xs text-paper-500">The diff is cut short.</p>
      )}
    </li>
  );
}

/** The reviewed update flow: read what changed upstream, choose skills, accept. */
function UpdateModal({ onClose, source }: { onClose: () => void; source: SkillSourceRow }) {
  const diff = useSkillSourceDiff(source.id);
  const accept = useAcceptSkillUpdate();
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const changed = diff.data?.changed ?? [];
  // Skills the admin has not touched are chosen by default; edited ones need an explicit choice.
  const chosen =
    picked ??
    new Set(
      changed
        .filter((c) => !c.handEdited && !c.diffIncomplete && !c.blockedByScan)
        .map((c) => c.name)
    );

  function toggle(name: string) {
    const next = new Set(chosen);
    if (!next.delete(name)) {
      next.add(name);
    }
    setPicked(next);
  }

  async function handleAccept() {
    if (!diff.data) {
      return;
    }
    setError(null);
    try {
      const summary = await accept.mutateAsync({
        id: source.id,
        sha: diff.data.sha,
        skills: changed
          .filter((c) => chosen.has(c.name))
          .map((c) => ({ name: c.name, revision: c.installedRevision })),
      });
      setDone(
        `Updated ${summary.accepted.length} ${summary.accepted.length === 1 ? 'skill' : 'skills'}. They are unverified until you review and mark them verified.${summary.pinAdvanced ? '' : ' Some changes were left out, so the source still shows an update.'}`
      );
    } catch (err) {
      setError(errMsg(err, 'Could not apply the update'));
    }
  }

  return (
    <Modal
      dismissible={!accept.isPending}
      onClose={onClose}
      open
      size="lg"
      subtitle="Nothing changes until you accept. Runs already in progress keep the text they started with."
      title={`Update from ${describe(source)}`}
    >
      {done ? (
        <div className="space-y-4">
          <Alert variant="success">{done}</Alert>
          <ModalFooter cancelLabel="Close" onCancel={onClose} />
        </div>
      ) : (
        <div className="space-y-4">
          {diff.isLoading && <p className="text-sm text-paper-400">Reading the repository…</p>}
          {diff.isError && <Alert>{errMsg(diff.error, 'Could not read the update')}</Alert>}
          {diff.data && (
            <>
              <p className="text-sm text-paper-300">
                Pinned commit{' '}
                <span className="font-mono text-xs">{source.pinnedSha.slice(0, 7)}</span> to{' '}
                <span className="font-mono text-xs">{diff.data.sha.slice(0, 7)}</span>.{' '}
                {changed.length === 0
                  ? 'None of the imported skills changed.'
                  : `${changed.length} ${changed.length === 1 ? 'skill' : 'skills'} changed.`}
              </p>
              {changed.length > 0 && (
                <ul className="max-h-96 space-y-2 overflow-y-auto">
                  {changed.map((c) => (
                    <ChangedSkill
                      checked={chosen.has(c.name)}
                      key={c.skillId}
                      onToggle={() => toggle(c.name)}
                      skill={c}
                    />
                  ))}
                </ul>
              )}
              {diff.data.removed.length > 0 && (
                <p className="text-xs text-paper-400">
                  No longer in the repository (left installed):{' '}
                  {diff.data.removed.map((r) => r.name).join(', ')}
                </p>
              )}
              {diff.data.added.length > 0 && (
                <p className="text-xs text-paper-400">
                  New in the repository (not imported by an update):{' '}
                  {diff.data.added.map((a) => a.name ?? a.folder).join(', ')}
                </p>
              )}
              {diff.data.errors.length > 0 && (
                <Alert variant="warning">
                  Could not read: {diff.data.errors.map((e) => e.name).join(', ')}. They stay as
                  they are.
                </Alert>
              )}
            </>
          )}
          {error && <Alert>{error}</Alert>}
          <ModalFooter
            disabled={chosen.size === 0 || !diff.data}
            isPending={accept.isPending}
            onCancel={onClose}
            onSubmit={handleAccept}
            pendingLabel="Applying…"
            submitLabel={`Accept ${chosen.size} ${chosen.size === 1 ? 'update' : 'updates'}`}
          />
        </div>
      )}
    </Modal>
  );
}

/**
 * The repositories skills were imported from: the commit each is pinned to, whether upstream has
 * moved, and the reviewed update flow. Removing a source keeps its skills, as ordinary custom ones.
 */
export function SkillSourcesCard() {
  const { data: sources, error: loadError, isError, isLoading } = useSkillSources();
  const check = useCheckSkillSource();
  const remove = useDeleteSkillSource();
  const [reviewing, setReviewing] = useState<SkillSourceRow | null>(null);
  const [removing, setRemoving] = useState<SkillSourceRow | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function handleCheck(source: SkillSourceRow) {
    setNotice(null);
    setCheckingId(source.id);
    try {
      const res = await check.mutateAsync(source.id);
      setNotice(
        res.data.check.error
          ? { text: `${describe(source)}: ${res.data.check.error}`, tone: 'error' }
          : { text: `Checked ${describe(source)}.`, tone: 'success' }
      );
    } catch (err) {
      setNotice({ text: errMsg(err, `Could not check ${describe(source)}`), tone: 'error' });
    } finally {
      setCheckingId(null);
    }
  }

  // A repository only appears here once something was imported from it.
  if (!isLoading && !isError && (sources?.length ?? 0) === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Imported from GitHub</CardTitle>
      </CardHeader>
      <p className="mb-3 text-xs text-paper-500">
        Each source is pinned to a commit. When the branch moves you review what changed before any
        skill's text is updated.
      </p>
      {notice && (
        <Alert className="mb-3" variant={notice.tone}>
          {notice.text}
        </Alert>
      )}
      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="skill sources"
      >
        {!sources?.length ? (
          <EmptyState className="py-4" title="Nothing imported yet." />
        ) : (
          <Table>
            <THead>
              <Th variant="compact">Repository</Th>
              <Th variant="compact">Pinned to</Th>
              <Th variant="compact">Status</Th>
              <Th variant="compact">Skills</Th>
              <Th variant="compact" />
            </THead>
            <tbody>
              {sources.map((s) => (
                <TRow key={s.id}>
                  <Td className="py-2 pr-4">
                    <div className="font-mono text-xs text-paper-100">{describe(s)}</div>
                    <div className="text-[11px] text-paper-500">
                      {s.ref}
                      {s.host !== 'github.com' ? ` on ${s.host}` : ''}
                    </div>
                  </Td>
                  <Td className="py-2 pr-4 font-mono text-xs text-paper-300">
                    {s.pinnedSha.slice(0, 7)}
                  </Td>
                  <Td className="py-2 pr-4">
                    <Badge dot tone={STATUS[s.status].tone} variant="text">
                      {STATUS[s.status].label}
                    </Badge>
                    <div className="text-[11px] text-paper-500">
                      {s.lastCheckedAt
                        ? `Checked ${formatRelativeTime(s.lastCheckedAt)}`
                        : 'Not checked yet'}
                    </div>
                    {s.lastError && <div className="text-[11px] text-brick-400">{s.lastError}</div>}
                  </Td>
                  <Td className="py-2 pr-4 tabular-nums text-paper-400">{s.skillCount}</Td>
                  <Td className="py-2 text-right">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {s.status === 'UPDATE_AVAILABLE' && (
                        <Button onClick={() => setReviewing(s)} size="sm" variant="primary">
                          Review update
                        </Button>
                      )}
                      <Button
                        disabled={checkingId === s.id || s.status === 'DISABLED'}
                        onClick={() => handleCheck(s)}
                        size="sm"
                        variant="secondary"
                      >
                        {checkingId === s.id ? 'Checking…' : 'Check now'}
                      </Button>
                      <Button onClick={() => setRemoving(s)} size="sm" variant="danger">
                        Remove
                      </Button>
                    </div>
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>
      {reviewing && (
        <UpdateModal
          key={`${reviewing.id}-${reviewing.latestSha}`}
          onClose={() => setReviewing(null)}
          source={reviewing}
        />
      )}
      <ConfirmModal
        confirmLabel="Remove source"
        dangerous
        message={
          removing
            ? `Stop tracking ${describe(removing)}? Its ${removing.skillCount} ${removing.skillCount === 1 ? 'skill stays' : 'skills stay'} installed as ordinary custom skills, but will no longer get updates from the repository.`
            : ''
        }
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing) {
            await remove.mutateAsync(removing.id);
          }
        }}
        open={removing !== null}
        pendingLabel="Removing…"
        title="Remove skill source?"
      />
    </Card>
  );
}
