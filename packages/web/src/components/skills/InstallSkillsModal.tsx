'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import {
  type DiffAddedSkill,
  type SkillSource,
  useInstallIntoSource,
  useSourceDiff,
} from '@/hooks/useSkillSources';
import { errMsg } from '@/lib/errors';
import { visibleText } from '@/lib/visibleText';
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
  installing,
  onInstall,
  skill: a,
}: {
  error: string | undefined;
  installing: boolean;
  onInstall: () => void;
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
          disabled={installing || reason !== null}
          onClick={onInstall}
          size="sm"
        >
          {installing ? 'Installing…' : 'Install'}
        </Button>
      </div>
      {a.description && <div className="text-xs text-paper-400">{visibleText(a.description)}</div>}
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

function InstallBody({ onClose, source }: { onClose: () => void; source: SkillSource }) {
  // The commit the source is installed at: what is shown is read, scanned and checked
  // there, and the install sends this same sha, so the admin installs what they saw.
  const diffQuery = useSourceDiff(source.id, source.pinnedSha);
  const install = useInstallIntoSource();
  const [installing, setInstalling] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);
  const diff = diffQuery.data;

  async function doInstall(a: DiffAddedSkill) {
    if (!diff || a.name === null) {
      return;
    }
    setInstalling(a.folder);
    setErrors((cur) => ({ ...cur, [a.folder]: '' }));
    try {
      await install.mutateAsync({ id: source.id, sha: diff.sha, skills: [a.name] });
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
        installed uses. Installing adds them unverified at that commit and never moves the pin. A
        skill that is new upstream appears here once an accepted update has advanced the pin.
      </p>
      {done.length > 0 && (
        <Alert variant="success">Installed {done.length} skill(s), unverified.</Alert>
      )}
      {stale && (
        <Alert variant="warning">
          The source changed since this was read.{' '}
          <Button
            onClick={() => {
              setStale(false);
              setErrors({});
              diffQuery.refetch();
            }}
            size="sm"
          >
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
              installing={installing === a.folder}
              key={a.folder}
              onInstall={() => doInstall(a)}
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
  source,
}: {
  onClose: () => void;
  source: SkillSource | null;
}) {
  return (
    <Modal
      onClose={onClose}
      open={source !== null}
      size="lg"
      subtitle={source ? sourceLabel(source) : undefined}
      title="Install more skills"
    >
      {source !== null && <InstallBody key={source.id} onClose={onClose} source={source} />}
    </Modal>
  );
}
