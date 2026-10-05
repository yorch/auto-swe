'use client';

import { Fragment, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type IncomingSkill,
  type PreviewSkill,
  type ScriptMode,
  type SourceLocationInput,
  type SourcePreview,
  useCreateSource,
  usePreviewSource,
  useReadPreviewSkill,
} from '@/hooks/useSkillSources';
import { useTeams } from '@/hooks/useTeams';
import { visibleText } from '@/lib/visibleText';
import { FullText } from './FullText';
import { describeApiError, keyed, shortSha, sourceLabel } from './sourceDisplay';

interface FormState {
  host: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  scriptMode: ScriptMode;
  scope: 'GLOBAL' | 'TEAM';
  teamId: string;
}

const EMPTY: FormState = {
  host: 'github.com',
  owner: '',
  path: '',
  ref: 'main',
  repo: '',
  scope: 'GLOBAL',
  scriptMode: 'TEXT_ONLY',
  teamId: '',
};

/** Why a previewed skill cannot be picked; null when it can. */
export function unselectableReason(s: PreviewSkill): string | null {
  if (s.name === null || s.errors.length > 0) {
    return 'has errors';
  }
  if (s.conflicts.length > 0) {
    return 'name already in use';
  }
  if (s.blockedByScan) {
    return 'scan warnings (blocked by skills.import.blockOnScanWarnings)';
  }
  return s.installable ? null : 'not installable';
}

function Notes({ skill }: { skill: PreviewSkill }) {
  return (
    <ul className="space-y-0.5 text-xs">
      {keyed(skill.errors).map((e) => (
        <li className="text-brick-400" key={`e-${e.key}`}>
          error: {visibleText(e.text)}
        </li>
      ))}
      {skill.conflicts.map((c) => (
        <li className="text-brick-400" key={`c-${c.id}`}>
          name already used by a {visibleText(c.scope)} skill
        </li>
      ))}
      {keyed(skill.scanWarnings).map((w) => (
        <li className="text-amber-400" key={`w-${w.key}`}>
          scan: {visibleText(w.text)}
        </li>
      ))}
      {skill.skippedFiles.length > 0 && (
        <li className="text-paper-500">
          skipped {skill.skippedFiles.length} file(s):{' '}
          {skill.skippedFiles
            .map((f) => `${visibleText(f.path)} (${visibleText(f.reason)})`)
            .join(', ')}
        </li>
      )}
      {skill.ignoredKeys.length > 0 && (
        <li className="text-paper-500">
          ignored frontmatter: {skill.ignoredKeys.map((k) => visibleText(k)).join(', ')}
        </li>
      )}
      {skill.referenceFileCount > 0 && (
        <li className="text-paper-500">{skill.referenceFileCount} reference file(s) kept</li>
      )}
    </ul>
  );
}

/**
 * Add a source: describe the repository, preview what it holds (writes
 * nothing), tick the skills to install, create. The create is bound to the
 * previewed commit, so a repository that moved since is a 409 and a re-preview.
 */
export function AddSourceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const preview = usePreviewSource();
  const create = useCreateSource();
  const readPreview = useReadPreviewSkill();
  const { data: teams } = useTeams();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [previewed, setPreviewed] = useState<SourcePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Full texts read, by `sha:folder`: a text is about exactly the commit that was previewed.
  const [fulls, setFulls] = useState<Record<string, IncomingSkill>>({});
  const [reading, setReading] = useState<string | null>(null);
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ message: string; lines: string[]; moved?: boolean } | null>(
    null
  );

  function close() {
    setForm(EMPTY);
    setPreviewed(null);
    setSelected(new Set());
    setFulls({});
    setReadErrors({});
    setError(null);
    onClose();
  }

  const body = (): SourceLocationInput => ({
    host: form.host.trim(),
    owner: form.owner.trim(),
    path: form.path.trim(),
    ref: form.ref.trim(),
    repo: form.repo.trim(),
    scope: form.scope,
    scriptMode: form.scriptMode,
    ...(form.scope === 'TEAM' ? { teamId: form.teamId } : {}),
  });

  async function runPreview(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    try {
      const result = await preview.mutateAsync(body());
      setPreviewed(result);
      setSelected(new Set());
      setFulls({});
      setReadErrors({});
    } catch (err) {
      const d = describeApiError(err, 'Failed to read the repository');
      setError({ lines: d.lines, message: d.message });
    }
  }

  async function readFull(skill: PreviewSkill) {
    if (!previewed || skill.name === null) {
      return;
    }
    setReading(skill.folder);
    setReadErrors((cur) => ({ ...cur, [skill.folder]: '' }));
    try {
      const r = await readPreview.mutateAsync({ ...body(), sha: previewed.sha, skill: skill.name });
      if (r.sha === previewed.sha) {
        setFulls((cur) => ({ ...cur, [`${previewed.sha}:${skill.folder}`]: r }));
      } else {
        setReadErrors((cur) => ({
          ...cur,
          [skill.folder]: 'The repository changed since the preview. Preview it again.',
        }));
      }
    } catch (err) {
      const d = describeApiError(err, 'Failed to read the full text');
      setReadErrors((cur) => ({ ...cur, [skill.folder]: visibleText(d.message) }));
    } finally {
      setReading(null);
    }
  }

  async function runCreate() {
    if (!previewed) {
      return;
    }
    setError(null);
    try {
      // Only skills whose full text was read at this commit are sent, whatever the selection holds.
      const skills = previewed.skills.flatMap((s) =>
        s.name !== null && selected.has(s.name) && fulls[`${previewed.sha}:${s.folder}`]
          ? [s.name]
          : []
      );
      if (skills.length === 0) {
        setError({ lines: [], message: 'Read the full text of a skill before installing it.' });
        return;
      }
      await create.mutateAsync({ ...body(), sha: previewed.sha, skills });
      close();
    } catch (err) {
      const d = describeApiError(err, 'Failed to import the skills');
      if (d.code === 'SKILL_SOURCE_SHA_MOVED') {
        setError({
          lines: [],
          message: 'The repository changed since the preview. Preview it again before importing.',
          moved: true,
        });
      } else if (d.code === 'SKILL_IMPORT_NAME_CONFLICT') {
        setError({
          lines: d.lines,
          message: 'These names are already taken; nothing was imported. Leave them out.',
        });
      } else {
        // 422 (errors, scan warnings, limits) and anything else: the gateway's reasons.
        setError({ lines: d.lines, message: d.message });
      }
    }
  }

  function toggle(name: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (!next.delete(name)) {
        next.add(name);
      }
      return next;
    });
  }

  const formValid =
    form.owner.trim() !== '' &&
    form.repo.trim() !== '' &&
    form.ref.trim() !== '' &&
    (form.scope === 'GLOBAL' || form.teamId !== '');

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
      {error.moved && (
        <div className="mt-2">
          <Button disabled={preview.isPending} onClick={() => runPreview()} size="sm">
            Preview again
          </Button>
        </div>
      )}
    </Alert>
  );

  if (previewed) {
    const pickable = previewed.skills.filter((s) => unselectableReason(s) === null);
    return (
      <Modal
        onClose={close}
        open={open}
        size="lg"
        subtitle={`${sourceLabel(previewed.location)} @ ${shortSha(previewed.sha)}`}
        title="Choose skills to install"
      >
        <div className="space-y-4">
          <p className="text-xs text-paper-500">
            Nothing has been written yet. Read a skill's full text to be able to choose it (each
            read costs one full fetch of the repository). Skills with errors, a name conflict
            {previewed.skills.some((s) => s.blockedByScan) ? ', or blocking scan warnings' : ''}{' '}
            cannot be chosen. Installed skills start unverified.
          </p>
          <Table>
            <THead>
              <Th variant="compact" />
              <Th variant="compact">Skill</Th>
              <Th variant="compact">Chars</Th>
              <Th variant="compact">Notes</Th>
            </THead>
            <tbody>
              {previewed.skills.map((s) => {
                const reason = unselectableReason(s);
                const label = visibleText(s.name ?? s.folder);
                const full = fulls[`${previewed.sha}:${s.folder}`];
                return (
                  <Fragment key={s.folder}>
                    <TRow>
                      <Td className="py-2 pr-2 align-top">
                        <input
                          aria-label={`Install ${label}`}
                          checked={s.name !== null && selected.has(s.name)}
                          className="h-4 w-4 accent-ember-400"
                          disabled={reason !== null || !full}
                          onChange={() => s.name !== null && toggle(s.name)}
                          title={reason ?? (full ? undefined : 'Read the full text first')}
                          type="checkbox"
                        />
                      </Td>
                      <Td className="py-2 pr-4 align-top">
                        <div className="font-medium text-paper-100">{label}</div>
                        <div className="font-mono text-[11px] text-paper-500">
                          {visibleText(s.folder)}
                        </div>
                        {s.description && (
                          <div className="mt-0.5 text-xs text-paper-400">
                            {visibleText(s.description)}
                          </div>
                        )}
                        {reason && (
                          <Badge className="mt-1" tone="muted">
                            {reason}
                          </Badge>
                        )}
                      </Td>
                      <Td className="py-2 pr-4 align-top tabular-nums text-paper-400">
                        {s.textLength}
                      </Td>
                      <Td className="py-2 align-top">
                        <Notes skill={s} />
                        {reason === null && (
                          <div className="mt-1 space-y-0.5">
                            <Button
                              aria-label={`Read full text of ${label}`}
                              disabled={reading === s.folder}
                              onClick={() => readFull(s)}
                              size="sm"
                            >
                              {reading === s.folder
                                ? 'Reading…'
                                : full
                                  ? 'Read again'
                                  : 'Read full text'}
                            </Button>
                            {readErrors[s.folder] && (
                              <div className="text-xs text-brick-400">{readErrors[s.folder]}</div>
                            )}
                          </div>
                        )}
                      </Td>
                    </TRow>
                    {full && (
                      <TRow>
                        <Td className="pb-3" colSpan={4}>
                          <FullText label={`Full text of ${label}`} text={full.promptText} />
                        </Td>
                      </TRow>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
          {pickable.length === 0 && (
            <Alert variant="warning">No skill here can be installed.</Alert>
          )}
          {errorAlert}
          <ModalFooter
            disabled={selected.size === 0}
            isPending={create.isPending}
            onCancel={() => {
              setPreviewed(null);
              setError(null);
            }}
            onSubmit={runCreate}
            pendingLabel="Importing…"
            submitLabel={`Install ${selected.size} skill${selected.size === 1 ? '' : 's'}`}
          >
            <span className="text-xs text-paper-500">Cancel goes back to the form</span>
          </ModalFooter>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={close} open={open} title="Add external source">
      <form className="space-y-4" onSubmit={runPreview}>
        <Input
          id="skill-source-host"
          label="Host"
          onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
          required
          value={form.host}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            id="skill-source-owner"
            label="Owner"
            onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
            required
            value={form.owner}
          />
          <Input
            id="skill-source-repo"
            label="Repository"
            onChange={(e) => setForm((f) => ({ ...f, repo: e.target.value }))}
            required
            value={form.repo}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            hint="Folder to search for skills; empty is the whole repository"
            id="skill-source-path"
            label="Path"
            onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
            value={form.path}
          />
          <Input
            hint="Branch or tag; it is resolved to a commit and pinned"
            id="skill-source-ref"
            label="Ref"
            onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))}
            required
            value={form.ref}
          />
        </div>
        <RadioGroup<ScriptMode>
          legend="Script mode"
          name="skill-source-script-mode"
          onChange={(scriptMode) => setForm((f) => ({ ...f, scriptMode }))}
          options={[
            {
              description:
                'SKILL.md becomes the prompt; .md and .txt files are kept as reference text; everything else is skipped and listed. Nothing is ever executed.',
              label: 'Text only',
              value: 'TEXT_ONLY',
            },
            {
              description: 'A skill folder that contains scripts or binaries is refused.',
              label: 'Reject scripts',
              value: 'REJECT',
            },
          ]}
          value={form.scriptMode}
        />
        <RadioGroup<'GLOBAL' | 'TEAM'>
          legend="Scope"
          name="skill-source-scope"
          onChange={(scope) => setForm((f) => ({ ...f, scope }))}
          options={[
            { description: 'Visible to every team.', label: 'Global', value: 'GLOBAL' },
            { description: 'Visible to one team only.', label: 'Team', value: 'TEAM' },
          ]}
          value={form.scope}
        />
        {form.scope === 'TEAM' && (
          <Select
            aria-label="Team"
            label="Team"
            onChange={(teamId) => setForm((f) => ({ ...f, teamId }))}
            options={(teams ?? []).map((t) => ({ label: t.name, value: t.id }))}
            placeholder="Choose a team"
            value={form.teamId}
          />
        )}
        {error && errorAlert}
        <ModalFooter
          disabled={!formValid}
          isPending={preview.isPending}
          onCancel={close}
          pendingLabel="Reading repository…"
          submitLabel="Preview"
        />
      </form>
    </Modal>
  );
}
