'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import {
  type AcceptResult,
  type DiffChangedSkill,
  type IncomingSkill,
  type SourceDiff,
  useAcceptUpdate,
  useReadIncomingSkill,
  useSourceDiff,
} from '@/hooks/useSkillSources';
import { errMsg } from '@/lib/errors';
import { visibleOrNull, visibleText } from '@/lib/visibleText';
import { FullText } from './FullText';
import { describeApiError, keyed, shortSha } from './sourceDisplay';
import { UnifiedDiff } from './UnifiedDiff';

/** Refusals that all mean "what you reviewed is no longer what is there". */
const REOPEN_CODES = new Set([
  'SKILL_UPDATE_STALE_SHA',
  'SKILL_CHANGED',
  'SKILL_UPDATE_DIFF_INCOMPLETE',
  'SKILL_UPDATE_SOURCE_CHANGED',
  'SKILL_UPDATE_DISABLED',
  'SKILL_UPDATE_NOT_CHECKED',
]);

interface Confirms {
  read?: boolean;
  overwrite?: boolean;
}

interface Failure {
  message: string;
  lines: string[];
  reopen: boolean;
}

function FileChanges({ files }: { files: DiffChangedSkill['referenceFiles'] }) {
  const rows = [
    ['added', files.added],
    ['changed', files.changed],
    ['removed', files.removed],
  ] as const;
  return (
    <>
      {rows
        .filter(([, paths]) => paths.length > 0)
        .map(([label, paths]) => (
          <div className="text-xs text-paper-400" key={label}>
            reference files {label}: {paths.map((p) => visibleText(p)).join(', ')}
          </div>
        ))}
    </>
  );
}

function ChangedSkill({
  confirms,
  full,
  onConfirm,
  onPick,
  onReadFull,
  picked,
  reading,
  skill: c,
}: {
  confirms: Confirms;
  full: IncomingSkill | undefined;
  onConfirm: (key: keyof Confirms, value: boolean) => void;
  onPick: (value: boolean) => void;
  onReadFull: () => void;
  picked: boolean;
  reading: boolean;
  skill: DiffChangedSkill;
}) {
  const name = visibleText(c.name);
  const confirmed =
    (!c.diffIncomplete || !!confirms.read) && (!c.handEdited || !!confirms.overwrite);
  return (
    <section
      aria-label={`Changed skill ${name}`}
      className="space-y-2 rounded-[9px] border border-ink-600 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          checked={picked}
          disabled={c.blockedByScan || !confirmed}
          label={<span className="font-medium text-paper-100">Update {name}</span>}
          onChange={(e) => onPick(e.target.checked)}
        />
        <span className="text-xs text-paper-500">
          installed revision {c.installedRevision} · {c.textLength.old} → {c.textLength.new} chars
        </span>
        {c.handEdited && <Badge tone="amber">edited by hand</Badge>}
        {c.diffIncomplete && (
          <Badge tone="amber">{c.diffTooLarge ? 'diff too large' : 'diff incomplete'}</Badge>
        )}
        {c.blockedByScan && <Badge tone="brick">blocked by scan warnings</Badge>}
      </div>
      {c.renamedTo && (
        <div className="text-xs text-paper-400">
          Upstream now names it {visibleText(c.renamedTo)}; accepting keeps the installed name.
        </div>
      )}
      {c.description.changed && (
        <div className="text-xs text-paper-400">
          description:{' '}
          <span className="text-brick-400">{visibleOrNull(c.description.old) ?? '—'}</span>
          {' → '}
          <span className="text-moss-400">{visibleOrNull(c.description.new) ?? '—'}</span>
        </div>
      )}
      {c.textDiff ? (
        <UnifiedDiff text={c.textDiff} />
      ) : (
        <div className="text-xs text-paper-500">
          {c.diffTooLarge ? 'The diff is too large to show.' : 'No change to the prompt text.'}
        </div>
      )}
      <FileChanges files={c.referenceFiles} />
      {keyed(c.scanWarnings).map((w) => (
        <div className="text-xs text-amber-400" key={w.key}>
          scan: {visibleText(w.text)}
        </div>
      ))}
      {c.diffIncomplete && (
        <div className="space-y-2">
          <Button disabled={reading} onClick={onReadFull} size="sm">
            {reading ? 'Reading…' : 'Read full incoming text'}
          </Button>
          {full && <FullText label={`Full incoming text of ${name}`} text={full.promptText} />}
          <Checkbox
            checked={!!confirms.read}
            disabled={!full}
            label="I've read the full text"
            onChange={(e) => onConfirm('read', e.target.checked)}
          />
        </div>
      )}
      {c.handEdited && (
        <Checkbox
          checked={!!confirms.overwrite}
          label="Overwrite my edit: the installed text was edited by hand and this replaces it"
          onChange={(e) => onConfirm('overwrite', e.target.checked)}
        />
      )}
    </section>
  );
}

function ReviewBody({ onClose, sourceId }: { onClose: () => void; sourceId: string }) {
  const diffQuery = useSourceDiff(sourceId);
  const accept = useAcceptUpdate();
  const readFull = useReadIncomingSkill();
  // Only what the admin changed is stored; everything else derives from the diff.
  const [picks, setPicks] = useState<Record<string, boolean>>({});
  const [confirms, setConfirms] = useState<Record<string, Confirms>>({});
  const [fulls, setFulls] = useState<Record<string, IncomingSkill>>({});
  const [reading, setReading] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<AcceptResult | null>(null);

  const diff: SourceDiff | undefined = diffQuery.data;

  // Everything the admin chose is about exactly this commit, this skill and this installed
  // revision. Keyed by all three, a confirmation can never be carried over to different data.
  const idOf = (c: DiffChangedSkill) => `${diff?.sha}:${c.skillId}:${c.installedRevision}`;
  const confirmedOf = (c: DiffChangedSkill) =>
    (!c.diffIncomplete || !!confirms[idOf(c)]?.read) &&
    (!c.handEdited || !!confirms[idOf(c)]?.overwrite);
  // Hand-edited and incomplete skills start unselected and need their confirmations.
  const pickedOf = (c: DiffChangedSkill) =>
    !c.blockedByScan && confirmedOf(c) && (picks[idOf(c)] ?? (!c.handEdited && !c.diffIncomplete));

  function reload() {
    setPicks({});
    setConfirms({});
    setFulls({});
    setFailure(null);
    diffQuery.refetch();
  }

  async function doReadFull(c: DiffChangedSkill) {
    if (!diff) {
      return;
    }
    setFailure(null);
    setReading(c.name);
    try {
      const r = await readFull.mutateAsync({ id: sourceId, name: c.name, sha: diff.sha });
      // A text read at another commit is not the text of this diff.
      if (r.sha === diff.sha) {
        setFulls((cur) => ({ ...cur, [idOf(c)]: r }));
      } else {
        setFailure({
          lines: [],
          message: 'The source moved while the text was being read. Reload the diff.',
          reopen: true,
        });
      }
    } catch (err) {
      setFailure({
        lines: [],
        message: errMsg(err, 'Failed to read the full text'),
        reopen: false,
      });
    } finally {
      setReading(null);
    }
  }

  async function doAccept() {
    if (!diff) {
      return;
    }
    setFailure(null);
    try {
      const skills = diff.changed
        .filter(pickedOf)
        .map((c) => ({ name: c.name, revision: c.installedRevision }));
      setResult(await accept.mutateAsync({ id: sourceId, sha: diff.sha, skills }));
    } catch (err) {
      const d = describeApiError(err, 'Failed to accept the update');
      if (d.code !== null && REOPEN_CODES.has(d.code)) {
        setFailure({
          lines: [],
          message: `${d.message} Re-open the diff and review it again; nothing was changed.`,
          reopen: true,
        });
      } else {
        setFailure({ lines: d.lines, message: d.message, reopen: false });
      }
    }
  }

  if (diffQuery.isLoading) {
    return <LoadingState message="reading the repository…" />;
  }
  if (!diff) {
    return (
      <div className="space-y-4">
        <Alert>{errMsg(diffQuery.error, 'Failed to load the diff')}</Alert>
        <ModalFooter cancelLabel="Close" onCancel={onClose} />
      </div>
    );
  }

  if (result) {
    return (
      <div className="space-y-4">
        <Alert variant="success">
          Updated {result.accepted.length} skill(s) to {shortSha(result.sha)}. The new revisions are
          unverified.
        </Alert>
        <ul className="space-y-1 text-sm text-paper-300">
          {result.accepted.map((a) => (
            <li key={a.id}>
              {visibleText(a.name)}: revision {a.fromRevision} → {a.revision}
            </li>
          ))}
        </ul>
        {result.conflicts.length > 0 && (
          <div className="text-xs text-amber-400">
            Left alone (edited by hand): {result.conflicts.map((n) => visibleText(n)).join(', ')}
          </div>
        )}
        {result.notSelected.length > 0 && (
          <div className="text-xs text-paper-400">
            Not selected: {result.notSelected.map((n) => visibleText(n)).join(', ')}
          </div>
        )}
        <div className="text-xs text-paper-500">
          {result.pinAdvanced
            ? `The source is now pinned to ${shortSha(result.after.pinnedSha)}.`
            : 'The pin did not move: skills that changed upstream were left behind, so the source stays UPDATE_AVAILABLE.'}
        </div>
        <ModalFooter cancelLabel="Close" onCancel={onClose} />
      </div>
    );
  }

  const selectedCount = diff.changed.filter(pickedOf).length;

  return (
    <div className="space-y-5">
      <p className="text-xs text-paper-500">
        Pinned {shortSha(diff.source.pinnedSha)} → {shortSha(diff.sha)}: {diff.changed.length}{' '}
        changed, {diff.unchanged.length} unchanged, {diff.added.length} not installed,{' '}
        {diff.removed.length} removed. Accepting creates new unverified revisions; running workflows
        keep the revision they started with.
      </p>

      {diff.changed.length === 0 && <Alert variant="info">No installed skill changed.</Alert>}
      {diff.changed.map((c) => (
        <ChangedSkill
          confirms={confirms[idOf(c)] ?? {}}
          full={fulls[idOf(c)]}
          key={c.skillId}
          onConfirm={(key, value) =>
            setConfirms((cur) => ({ ...cur, [idOf(c)]: { ...cur[idOf(c)], [key]: value } }))
          }
          onPick={(value) => setPicks((cur) => ({ ...cur, [idOf(c)]: value }))}
          onReadFull={() => doReadFull(c)}
          picked={pickedOf(c)}
          reading={reading === c.name}
          skill={c}
        />
      ))}

      {diff.errors.length > 0 && (
        <Alert variant="warning">
          Cannot be updated:
          <ul className="mt-1 list-disc pl-5">
            {diff.errors.map((e) => (
              <li key={e.skillId}>
                {visibleText(e.name)}: {e.errors.map((x) => visibleText(x)).join('; ')}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {diff.removed.length > 0 && (
        <div className="text-xs text-paper-400">
          No longer in the source (left installed):{' '}
          {diff.removed.map((r) => `${visibleText(r.name)} (${visibleText(r.folder)})`).join(', ')}
        </div>
      )}

      {diff.added.length > 0 && (
        <div className="text-xs text-paper-400">
          In the source at {shortSha(diff.sha)}, not installed:{' '}
          {diff.added.map((a) => visibleText(a.name ?? a.folder)).join(', ')}. An accept never
          installs them; use <em>Install more skills</em> on the source (it installs what the pinned
          commit holds).
        </div>
      )}

      {failure && (
        <Alert>
          {failure.message}
          {failure.lines.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {keyed(failure.lines).map((l) => (
                <li key={l.key}>{l.text}</li>
              ))}
            </ul>
          )}
          {failure.reopen && (
            <div className="mt-2">
              <Button onClick={reload} size="sm">
                Reload diff
              </Button>
            </div>
          )}
        </Alert>
      )}

      <ModalFooter
        cancelLabel="Close"
        disabled={selectedCount === 0}
        isPending={accept.isPending}
        onCancel={onClose}
        onSubmit={doAccept}
        pendingLabel="Accepting…"
        submitLabel={`Accept ${selectedCount} skill${selectedCount === 1 ? '' : 's'}`}
      />
    </div>
  );
}

/** Review a source's pending update: per-skill diffs, then accept the ones you read. */
export function ReviewUpdateModal({
  onClose,
  sourceId,
}: {
  onClose: () => void;
  sourceId: string | null;
}) {
  return (
    <Modal onClose={onClose} open={sourceId !== null} size="lg" title="Review update">
      {/* Keyed by source so a second review never inherits the first one's selections. */}
      {sourceId !== null && <ReviewBody key={sourceId} onClose={onClose} sourceId={sourceId} />}
    </Modal>
  );
}
