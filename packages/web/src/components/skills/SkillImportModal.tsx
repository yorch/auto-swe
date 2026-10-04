'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  type PreviewSkill,
  type SkillScriptMode,
  type SkillSourceLocation,
  type SkillSourcePreview,
  useImportSkillSource,
  usePreviewSkillSource,
} from '@/hooks/useSkillSources';
import { errMsg } from '@/lib/errors';

/** `owner/repo`, or a github.com style URL, to its parts; null when it is neither. */
export function parseRepository(
  input: string
): { host?: string; owner: string; repo: string } | null {
  const text = input.trim().replace(/\.git$/, '');
  const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\/.*)?$/.exec(text);
  if (url) {
    return { host: url[1], owner: url[2], repo: url[3] };
  }
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(text);
  return short ? { owner: short[1], repo: short[2] } : null;
}

const SCRIPT_MODES: Array<{ label: string; value: SkillScriptMode }> = [
  { label: 'Keep the text, skip other files', value: 'TEXT_ONLY' },
  { label: 'Refuse a skill that has other files', value: 'REJECT' },
];

function SkillChoice({
  checked,
  onToggle,
  skill,
}: {
  checked: boolean;
  onToggle: () => void;
  skill: PreviewSkill;
}) {
  const problems = [
    ...skill.errors,
    ...skill.conflicts.map((c) => `A skill named "${c.name}" already exists`),
    ...(skill.blockedByScan
      ? ['The scanner flagged this text, and imports are set to refuse it']
      : []),
  ];
  return (
    <li className="rounded-[9px] border border-ink-600 p-3">
      <Checkbox
        checked={checked}
        disabled={!skill.installable}
        hint={skill.description ?? undefined}
        label={<span className="font-medium text-paper-100">{skill.name ?? skill.folder}</span>}
        onChange={onToggle}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-6.5 text-xs text-paper-500">
        <span>{skill.textLength.toLocaleString()} characters</span>
        {skill.referenceFileCount > 0 && (
          <span>
            {skill.referenceFileCount} reference file{skill.referenceFileCount === 1 ? '' : 's'}
          </span>
        )}
        {skill.skippedFiles.length > 0 && (
          <Badge tone="muted" variant="text">
            {skill.skippedFiles.length} other file{skill.skippedFiles.length === 1 ? '' : 's'}{' '}
            skipped
          </Badge>
        )}
      </div>
      {problems.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-9 text-xs text-brick-400">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {skill.scanWarnings.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-9 text-xs text-amber-400">
          {skill.scanWarnings.map((w) => (
            <li key={w}>Scanner: {w}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Import skills from a folder of a GitHub repository: name the source, review what is in it at
 * the commit it resolves to, pick the skills, import. Imported skills start unverified and stay
 * tied to the source, so a later change upstream shows up as a reviewable update.
 */
export function SkillImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [repository, setRepository] = useState('');
  const [ref, setRef] = useState('main');
  const [path, setPath] = useState('');
  const [host, setHost] = useState('');
  const [scriptMode, setScriptMode] = useState<SkillScriptMode>('TEXT_ONLY');
  const [location, setLocation] = useState<SkillSourceLocation | null>(null);
  const [preview, setPreview] = useState<SkillSourcePreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const previewSource = usePreviewSkillSource();
  const importSource = useImportSkillSource();

  const parsed = parseRepository(repository);

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    if (!parsed) {
      setError('Enter the repository as owner/name, or paste its GitHub URL.');
      return;
    }
    setError(null);
    const loc: SkillSourceLocation = {
      host: (host.trim() || parsed.host || 'github.com').toLowerCase(),
      owner: parsed.owner,
      path: path.trim().replace(/^\/+|\/+$/g, ''),
      ref: ref.trim() || 'main',
      repo: parsed.repo,
      scriptMode,
    };
    try {
      const result = await previewSource.mutateAsync(loc);
      setLocation(loc);
      setPreview(result);
      setPicked(
        new Set(result.skills.filter((s) => s.installable && s.name).map((s) => s.name as string))
      );
    } catch (err) {
      setError(errMsg(err, 'Could not read the repository'));
    }
  }

  async function handleImport() {
    if (!preview || !location) {
      return;
    }
    setError(null);
    try {
      await importSource.mutateAsync({ ...location, sha: preview.sha, skills: [...picked] });
      onImported(
        `Imported ${picked.size} ${picked.size === 1 ? 'skill' : 'skills'} from ${location.owner}/${location.repo}. They are unverified until you review and mark them verified.`
      );
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Import failed'));
    }
  }

  function toggle(name: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) {
        next.add(name);
      }
      return next;
    });
  }

  return (
    <Modal
      dismissible={!importSource.isPending}
      onClose={onClose}
      open
      size="lg"
      subtitle="Skills become part of agent prompts. Review what is in the repository before you import it."
      title="Import skills from GitHub"
    >
      {preview && location ? (
        <div className="space-y-4">
          <p className="text-sm text-paper-300">
            <span className="font-mono text-xs">
              {location.owner}/{location.repo}
              {location.path ? `/${location.path}` : ''}
            </span>{' '}
            at <span className="font-mono text-xs">{location.ref}</span> (commit{' '}
            <span className="font-mono text-xs">{preview.sha.slice(0, 7)}</span>)
          </p>
          <ul className="max-h-80 space-y-2 overflow-y-auto">
            {preview.skills.map((s) => (
              <SkillChoice
                checked={s.name !== null && picked.has(s.name)}
                key={s.folder}
                onToggle={() => s.name && toggle(s.name)}
                skill={s}
              />
            ))}
          </ul>
          {error && <Alert>{error}</Alert>}
          <ModalFooter
            cancelLabel="Back"
            disabled={picked.size === 0}
            isPending={importSource.isPending}
            onCancel={() => {
              setPreview(null);
              setError(null);
            }}
            onSubmit={handleImport}
            pendingLabel="Importing…"
            submitLabel={`Import ${picked.size} ${picked.size === 1 ? 'skill' : 'skills'}`}
          />
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handlePreview}>
          <Input
            hint="For example acme/agent-skills, or paste the repository's GitHub URL."
            id="skill-import-repo"
            label="Repository"
            onChange={(e) => setRepository(e.target.value)}
            placeholder="owner/name"
            required
            value={repository}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              hint="A branch or tag. The skills are pinned to the commit it names today."
              id="skill-import-ref"
              label="Branch or tag"
              onChange={(e) => setRef(e.target.value)}
              value={ref}
            />
            <Input
              hint="Leave empty to look through the whole repository."
              id="skill-import-path"
              label="Folder (optional)"
              onChange={(e) => setPath(e.target.value)}
              placeholder="skills"
              value={path}
            />
          </div>
          <Select
            id="skill-import-script-mode"
            label="Files beside a skill"
            onChange={(v) => setScriptMode(v as SkillScriptMode)}
            options={SCRIPT_MODES}
            value={scriptMode}
          />
          <Input
            hint="Only for GitHub Enterprise. The host must be on the approved list."
            id="skill-import-host"
            label="GitHub host (optional)"
            onChange={(e) => setHost(e.target.value)}
            placeholder="github.com"
            value={host}
          />
          {error && <Alert>{error}</Alert>}
          <ModalFooter
            isPending={previewSource.isPending}
            onCancel={onClose}
            pendingLabel="Reading repository…"
            submitLabel="Preview"
          />
        </form>
      )}
    </Modal>
  );
}
