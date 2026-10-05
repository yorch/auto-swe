'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import {
  type DiffAddedSkill,
  type IncomingSkill,
  useInstallIntoSource,
  useReadIncomingSkill,
  useSkillSources,
  useSourceDiff,
} from '@/hooks/useSkillSources';
import { errMsg } from '@/lib/errors';
import { visibleText } from '@/lib/visibleText';
import { FullText } from './FullText';
import { describeApiError, keyed, shortSha, sourceLabel } from './sourceDisplay';

/** Why an added skill cannot be installed; null when it can. */
export function notInstallableReason(a: DiffAddedSkill): string | null {
  if (a.name === null || a.errors.length > 0) {
    return 'has errors';
  }
  if (a.conflicts.length > 0) {
    return 'name already in use';
  }
  if (a.blockedByScan) {
    return 'scan warnings (blocked by skills.import.blockOnScanWarnings)';
  }
  return null;
}

function AddedSkill({
  error,
  full,
  installing,
  onInstall,
  onReadFull,
  reading,
  skill: a,
}: {
  error: string | undefined;
  /** The complete text, once read at the commit being installed. */
  full: IncomingSkill | undefined;
  installing: boolean;
  onInstall: () => void;
  onReadFull: () => void;
  reading: boolean;
  skill: DiffAddedSkill;
}) {
  const label = visibleText(a.name ?? a.folder);
  const reason = notInstallableReason(a);
  return (
    <li className="space-y-1 rounded-[9px] border border-ink-600 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-paper-100">{label}</span>
        <span className="font-mono text-[11px] text-paper-500">{visibleText(a.folder)}</span>
        <span className="text-xs text-paper-500">{a.textLength} chars</span>
        {reason && <Badge tone="muted">{reason}</Badge>}
        <Button
          aria-label={`Install ${label}`}
          disabled={installing || reason !== null || !full}
          onClick={onInstall}
          size="sm"
          title={full ? undefined : 'Read the full text first'}
        >
          {installing ? 'Installing…' : 'Install'}
        </Button>
      </div>
      {a.description && <div className="text-xs text-paper-400">{visibleText(a.description)}</div>}
      {reason === null && (
        <div className="space-y-2">
          <Button
            aria-label={`Read full text of ${label}`}
            disabled={reading}
            onClick={onReadFull}
            size="sm"
          >
            {reading ? 'Reading…' : full ? 'Read again' : 'Read full text'}
          </Button>
          {full && <FullText label={`Full text of ${label}`} text={full.promptText} />}
        </div>
      )}
      {keyed(a.errors).map((e) => (
        <div className="text-xs text-brick-400" key={e.key}>
          error: {visibleText(e.text)}
        </div>
      ))}
      {a.conflicts.map((c) => (
        <div className="text-xs text-brick-400" key={c.id}>
          name already used by a {visibleText(c.scope)} skill
        </div>
      ))}
      {keyed(a.scanWarnings).map((w) => (
        <div className="text-xs text-amber-400" key={w.key}>
          scan: {visibleText(w.text)}
        </div>
      ))}
      {a.skippedFiles.length > 0 && (
        <div className="text-xs text-paper-500">
          skipped {a.skippedFiles.length} file(s):{' '}
          {a.skippedFiles
            .map((f) => `${visibleText(f.path)} (${visibleText(f.reason)})`)
            .join(', ')}
        </div>
      )}
      {error && <div className="text-xs text-brick-400">{error}</div>}
    </li>
  );
}

function InstallBody({ onClose, sourceId }: { onClose: () => void; sourceId: string }) {
  const sources = useSkillSources();
  const source = sources.data?.find((x) => x.id === sourceId);
  if (!source) {
    return (
      <div className="space-y-4">
        {sources.isLoading ? (
          <LoadingState message="loading…" />
        ) : (
          <Alert>This source no longer exists.</Alert>
        )}
        <ModalFooter cancelLabel="Close" onCancel={onClose} />
      </div>
    );
  }
  return (
    <InstallList
      key={source.pinnedSha}
      onClose={onClose}
      onReloadSource={() => sources.refetch()}
      pinnedSha={source.pinnedSha}
      sourceId={source.id}
    />
  );
}

function InstallList({
  onClose,
  onReloadSource,
  pinnedSha,
  sourceId,
}: {
  onClose: () => void;
  onReloadSource: () => unknown;
  pinnedSha: string;
  sourceId: string;
}) {
  // The commit the source is installed at: what is shown is read, scanned and checked
  // there, and the install sends this same sha, so the admin installs what they read. The
  // list is keyed by the pin, so a pin that moved starts this over on the current one.
  const diffQuery = useSourceDiff(sourceId, pinnedSha);
  const install = useInstallIntoSource();
  const readFull = useReadIncomingSkill();
  const [installing, setInstalling] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);
  // Full texts read, by `sha:folder`: a text is about exactly this commit and folder.
  const [fulls, setFulls] = useState<Record<string, IncomingSkill>>({});
  const diff = diffQuery.data;
  const keyOf = (a: DiffAddedSkill) => `${diff?.sha}:${a.folder}`;

  async function doReadFull(a: DiffAddedSkill) {
    if (!diff || a.name === null) {
      return;
    }
    setReading(a.folder);
    setErrors((cur) => ({ ...cur, [a.folder]: '' }));
    try {
      const r = await readFull.mutateAsync({ id: sourceId, name: a.name, sha: diff.sha });
      if (r.sha === diff.sha) {
        setFulls((cur) => ({ ...cur, [keyOf(a)]: r }));
      } else {
        setStale(true);
        setErrors((cur) => ({
          ...cur,
          [a.folder]: 'The text was read at a different commit than this list. Reload.',
        }));
      }
    } catch (err) {
      setErrors((cur) => ({
        ...cur,
        [a.folder]: visibleText(errMsg(err, 'Failed to read the full text')),
      }));
    } finally {
      setReading(null);
    }
  }

  async function doInstall(a: DiffAddedSkill) {
    if (!diff || a.name === null || !fulls[keyOf(a)]) {
      return;
    }
    setInstalling(a.folder);
    setErrors((cur) => ({ ...cur, [a.folder]: '' }));
    try {
      await install.mutateAsync({ id: sourceId, sha: diff.sha, skills: [a.name] });
      setDone((cur) => [...cur, a.folder]);
    } catch (err) {
      const d = describeApiError(err, 'Failed to install the skill');
      if (
        d.code === 'SKILL_IMPORT_STALE_SHA' ||
        d.code === 'SKILL_IMPORT_SOURCE_CHANGED' ||
        d.code === 'SKILL_IMPORT_DISABLED'
      ) {
        setStale(true);
      }
      setErrors((cur) => ({
        ...cur,
        [a.folder]: visibleText([d.message, ...d.lines].join(' ')),
      }));
    } finally {
      setInstalling(null);
    }
  }

  function reload() {
    setStale(false);
    setErrors({});
    setFulls({});
    // Re-read the source first: a pin that moved re-keys this list onto the current one.
    Promise.resolve(onReloadSource()).finally(() => diffQuery.refetch());
  }

  if (diffQuery.isLoading) {
    return <LoadingState message="reading the repository…" />;
  }
  if (!diff) {
    return (
      <div className="space-y-4">
        <Alert>{errMsg(diffQuery.error, 'Failed to read the source')}</Alert>
        <ModalFooter cancelLabel="Close" onCancel={onClose} />
      </div>
    );
  }
  const pending = diff.added.filter((a) => !done.includes(a.folder));
  return (
    <div className="space-y-4">
      <p className="text-xs text-paper-500">
        Read at the pinned commit {shortSha(diff.sha)}: the skills of that commit that nothing
        installed uses. Read a skill's full text, then install it: it is added unverified at that
        commit and the pin does not move. Each read costs one full fetch of the source. A skill that
        is new upstream appears here once an accepted update has advanced the pin.
      </p>
      {done.length > 0 && (
        <Alert variant="success">Installed {done.length} skill(s), unverified.</Alert>
      )}
      {stale && (
        <Alert variant="warning">
          The source changed since this was read.{' '}
          <Button onClick={reload} size="sm">
            Reload
          </Button>
        </Alert>
      )}
      {pending.length === 0 ? (
        <Alert variant="info">Every skill at the pinned commit is already installed.</Alert>
      ) : (
        <ul className="space-y-2">
          {pending.map((a) => (
            <AddedSkill
              error={errors[a.folder] || undefined}
              full={fulls[keyOf(a)]}
              installing={installing === a.folder}
              key={a.folder}
              onInstall={() => doInstall(a)}
              onReadFull={() => doReadFull(a)}
              reading={reading === a.folder}
              skill={a}
            />
          ))}
        </ul>
      )}
      <ModalFooter cancelLabel="Close" onCancel={onClose} />
    </div>
  );
}

/** Install more skills from a source's pinned commit. */
export function InstallSkillsModal({
  onClose,
  sourceId,
}: {
  onClose: () => void;
  sourceId: string | null;
}) {
  const { data } = useSkillSources(sourceId !== null);
  const source = data?.find((x) => x.id === sourceId);
  return (
    <Modal
      onClose={onClose}
      open={sourceId !== null}
      size="lg"
      subtitle={source ? sourceLabel(source) : undefined}
      title="Install more skills"
    >
      {sourceId !== null && <InstallBody key={sourceId} onClose={onClose} sourceId={sourceId} />}
    </Modal>
  );
}
