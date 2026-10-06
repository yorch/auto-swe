'use client';

import { useState } from 'react';
import { EntityMetaBadges } from '@/components/library/EntityMetaBadges';
import { SkillHistory } from '@/components/skills/SkillHistory';
import { SkillSourcesTab } from '@/components/skills/SkillSourcesTab';
import { shortSha } from '@/components/skills/sourceDisplay';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useHasRole } from '@/hooks/useHasRole';
import {
  type Skill,
  useCreateSkill,
  useDeleteSkill,
  useSkillEffectiveness,
  useSkills,
  useUpdateSkill,
  useVerifySkill,
} from '@/hooks/useSkills';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { originLabel } from '@/lib/originLabel';
import { cn, FOCUS_RING, formatCost, formatDate, formatPercent } from '@/lib/utils';
import { visibleOrNull, visibleText } from '@/lib/visibleText';

function OriginBadge({ origin }: { origin: string | null }) {
  if (!origin) {
    return null;
  }
  return <Badge tone="neutral">{originLabel(origin)}</Badge>;
}

/** `external: owner/repo@abc1234` for a skill imported from a repository. */
function ExternalBadge({ source }: { source: Skill['externalSource'] }) {
  if (!source) {
    return null;
  }
  return (
    <Badge
      className="font-mono"
      title={`${source.host}/${source.owner}/${source.repo}`}
      tone="violet"
    >
      {visibleText(`external: ${source.owner}/${source.repo}@${shortSha(source.sha)}`)}
    </Badge>
  );
}

/** Advisory findings from the skill content scanner; the save went through. */
function ScanWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <Alert variant="warning">
      Saved, but the content scanner flagged this text — review it before assigning the skill:
      <ul className="mt-1 list-disc pl-5">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </Alert>
  );
}

/** Names the agents that reference a skill, for the confirmations that affect them. */
function usageText(skill: Skill): string | null {
  if (skill.usedByCount === 0) {
    return null;
  }
  const names = skill.usedBy.length > 0 ? ` (${skill.usedBy.join(', ')})` : '';
  return `It is used by ${skill.usedByCount} agent ${skill.usedByCount === 1 ? 'version' : 'versions'}${names}.`;
}

// ── Skill Detail / Edit Modal ────────────────────────────────────────────────

function SkillDetailModal({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const update = useUpdateSkill();
  const [showHistory, setShowHistory] = useState(false);
  // The row handed in is a snapshot; the list is live, so a restore shows at once.
  const { data: allSkills } = useSkills();
  const verify = useVerifySkill();
  const isAdmin = useHasRole('ADMIN');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ description: '', isActive: true, name: '', promptText: '' });
  const [error, setError] = useState<string | null>(null);
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);
  // The revision on screen. Fixed when the modal opens and after an in-modal restore, so the text
  // a reviewer reads and the revision Verify attests never drift apart while the list refetches.
  const [viewed, setViewed] = useState<Skill | null>(skill);

  if (!skill) {
    if (viewed) {
      setViewed(null);
    }
    return null;
  }
  if (viewed?.id !== skill.id) {
    setViewed(skill);
  }

  const sk = viewed?.id === skill.id ? viewed : skill;
  const live = allSkills?.find((s) => s.id === skill.id);
  const movedOn = !!live && live.currentRevision !== sk.currentRevision;

  function startEdit() {
    setForm({
      description: sk.description ?? '',
      isActive: sk.isActive,
      name: sk.name,
      promptText: sk.promptText,
    });
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const patch: Parameters<typeof update.mutateAsync>[0] = {
        expectedRevision: sk.currentRevision,
        id: sk.id,
      };
      if (form.name !== sk.name) {
        patch.name = form.name;
      }
      if (form.description !== (sk.description ?? '')) {
        patch.description = form.description;
      }
      if (form.isActive !== sk.isActive) {
        patch.isActive = form.isActive;
      }
      if (!sk.isBuiltIn && form.promptText !== sk.promptText) {
        patch.promptText = form.promptText;
      }
      const { scanWarnings: warnings, skill: saved } = await update.mutateAsync(patch);
      setViewed({ ...sk, ...saved, scanWarnings: warnings });
      setEditing(false);
      if (warnings.length > 0) {
        // Saved, but the scanner flagged the text — keep the modal open to say so.
        setScanWarnings(warnings);
        return;
      }
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Failed to save skill'));
    }
  }

  // Attests to the revision of the skill object this modal rendered, whose text is on screen.
  async function handleVerify() {
    setVerifyError(null);
    try {
      await verify.mutateAsync({ id: sk.id, revision: sk.currentRevision });
      onClose();
    } catch (err) {
      setVerifyError(
        err instanceof ApiError && err.code === 'SKILL_CHANGED'
          ? 'This skill changed since you opened it. Reload it and read its current text before verifying.'
          : errMsg(err, 'Failed to verify the skill')
      );
    }
  }

  const title = editing ? `Edit "${visibleText(sk.name)}"` : visibleText(sk.name);

  return (
    <Modal
      onClose={() => {
        setEditing(false);
        setScanWarnings([]);
        setVerifyError(null);
        setShowHistory(false);
        onClose();
      }}
      open={!!skill}
      size="lg"
      title={title}
    >
      {editing ? (
        <form className="space-y-4" onSubmit={handleSave}>
          <Input
            id="skill-edit-name"
            label="Name"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
            value={form.name}
          />
          <Input
            id="skill-edit-description"
            label="Description"
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            value={form.description}
          />
          {sk.isBuiltIn ? (
            <FieldWrapper hint="Prompt text is locked for built-in skills." label="Prompt text">
              <pre className="w-full rounded-md border border-ink-500 bg-ink-900 px-3 py-2 text-xs text-paper-400 whitespace-pre-wrap break-words">
                {sk.promptText}
              </pre>
            </FieldWrapper>
          ) : (
            <Textarea
              id="skill-edit-prompt-text"
              label="Prompt text"
              onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
              required
              rows={12}
              value={form.promptText}
            />
          )}
          <ToggleSwitch
            checked={form.isActive}
            label={form.isActive ? 'Active' : 'Inactive'}
            onChange={() => setForm((f) => ({ ...f, isActive: !f.isActive }))}
          />
          {error && <Alert variant="error">{error}</Alert>}
          <ModalFooter
            isPending={update.isPending}
            onCancel={cancelEdit}
            pendingLabel="Saving…"
            submitLabel="Save changes"
          />
        </form>
      ) : (
        <div className="space-y-5">
          <ScanWarnings warnings={scanWarnings} />
          {movedOn && (
            <Alert variant="warning">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>This skill changed since you opened it — reload to read the new text.</span>
                <Button
                  onClick={() => {
                    setViewed(live);
                    setVerifyError(null);
                  }}
                  size="sm"
                  variant="secondary"
                >
                  Reload
                </Button>
              </div>
            </Alert>
          )}
          <EntityMetaBadges
            isActive={sk.isActive}
            isBuiltIn={sk.isBuiltIn}
            isVerified={sk.isVerified}
            origin={sk.origin}
          >
            <ExternalBadge source={sk.externalSource} />
            <Badge tone="neutral">
              used by {sk.usedByCount} agent{sk.usedByCount !== 1 ? 's' : ''}
            </Badge>
          </EntityMetaBadges>
          {sk.description && (
            <p className="text-sm text-paper-300">{visibleOrNull(sk.description)}</p>
          )}
          {sk.scanWarnings.length > 0 && (
            <Alert title="Scanner findings on this text" variant="warning">
              <ul className="list-disc space-y-0.5 pl-4 text-xs">
                {sk.scanWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Alert>
          )}
          <div>
            <div className="label-mono mb-1.5">Prompt text</div>
            <pre className="max-h-96 overflow-auto rounded-md border border-ink-600 bg-ink-900 p-3 text-xs text-paper-200 whitespace-pre-wrap break-words">
              {visibleText(sk.promptText, { multiline: true })}
            </pre>
            {isAdmin && !sk.isVerified && !sk.isBuiltIn && !movedOn && (
              <div className="mt-3 flex items-center gap-3">
                <Button disabled={verify.isPending} onClick={handleVerify} variant="secondary">
                  Verify revision {sk.currentRevision}
                </Button>
                <span className="text-xs text-paper-500">
                  Attests that you read the text above, revision {sk.currentRevision}.
                </span>
              </div>
            )}
            {verifyError && (
              <Alert className="mt-3" variant="error">
                {verifyError}
              </Alert>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-ink-600 pt-4">
            <div className="space-y-0.5 text-xs text-paper-500">
              <div>Created {formatDate(sk.createdAt)}</div>
              <div>Updated {formatDate(sk.updatedAt)}</div>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setShowHistory((v) => !v)} variant="ghost">
                {showHistory ? 'Hide history' : 'History'}
              </Button>
              <Button onClick={startEdit} variant="secondary">
                Edit
              </Button>
            </div>
          </div>
          {showHistory && (
            <SkillHistory
              onRestored={(restored, warnings) =>
                setViewed({ ...sk, ...restored, scanWarnings: warnings })
              }
              skill={sk}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Create Modal ─────────────────────────────────────────────────────────────

type SkillForm = {
  name: string;
  description: string;
  promptText: string;
};

function SkillFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<SkillForm>({ description: '', name: '', promptText: '' });
  const create = useCreateSkill();
  const [error, setError] = useState<string | null>(null);
  // Set after a save the scanner flagged: the skill exists, the modal stays
  // open only to show the findings.
  const [savedWarnings, setSavedWarnings] = useState<string[] | null>(null);

  function close() {
    setSavedWarnings(null);
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { scanWarnings } = await create.mutateAsync({
        description: form.description || undefined,
        name: form.name,
        promptText: form.promptText,
      });
      setForm({ description: '', name: '', promptText: '' });
      if (scanWarnings.length > 0) {
        setSavedWarnings(scanWarnings);
        return;
      }
      close();
    } catch (err) {
      setError(errMsg(err, 'Failed to create skill'));
    }
  }

  if (savedWarnings) {
    return (
      <Modal onClose={close} open={open} title="Skill created">
        <div className="space-y-4">
          <ScanWarnings warnings={savedWarnings} />
          <div className="flex justify-end">
            <Button onClick={close} variant="primary">
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={close} open={open} title="New skill">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Input
          id="skill-new-name"
          label="Name"
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          value={form.name}
        />
        <Input
          id="skill-new-description"
          label="Description"
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          value={form.description}
        />
        <Textarea
          id="skill-new-prompt-text"
          label="Prompt text"
          onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
          required
          rows={8}
          value={form.promptText}
        />
        {error && <Alert variant="error">{error}</Alert>}
        <ModalFooter
          isPending={create.isPending}
          onCancel={close}
          pendingLabel="Creating…"
          submitLabel="Create skill"
        />
      </form>
    </Modal>
  );
}

// ── Effectiveness Card ────────────────────────────────────────────────────────

function EffectivenessCard() {
  const {
    data,
    isLoading,
    isError,
    isFetching,
    error: loadError,
    refetch,
  } = useSkillEffectiveness();
  return (
    <Card className="p-4 sm:p-6">
      <CardHeader>
        <CardTitle eyebrow={`Last ${data?.windowDays ?? 30} days`}>Skill effectiveness</CardTitle>
      </CardHeader>
      <p className="-mt-2 mb-4 max-w-3xl text-[13px] leading-relaxed text-paper-400">
        Run outcomes for runs where each skill was active, against the all-runs baseline of{' '}
        <span className="text-paper-200 tabular-nums">
          {formatPercent(data?.baselineSuccessRate ?? null)}
        </span>{' '}
        success across <span className="text-paper-200 tabular-nums">{data?.totalRuns ?? 0}</span>{' '}
        runs. Correlational: skills are assigned per team and template, so a difference may reflect
        the team or workload rather than the skill.
      </p>
      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={false}
        label="skill effectiveness"
        onRetry={() => void refetch()}
      >
        {isLoading ? (
          <SkeletonRows rows={3} />
        ) : !data?.perSkill.length ? (
          <EmptyState
            bordered
            className="py-8"
            hint="Outcomes appear here once runs complete with skills attached to their agents."
            icon="analytics"
            title="No runs with active skills in this window yet"
          />
        ) : (
          <Table>
            <THead>
              <Th className="pl-0" variant="plain">
                Skill
              </Th>
              <Th align="right" variant="plain">
                Runs
              </Th>
              <Th align="right" variant="plain">
                Success rate
              </Th>
              <Th align="right" className="pr-0" variant="plain">
                Avg cost
              </Th>
            </THead>
            <tbody>
              {data.perSkill.map((s) => (
                <TRow key={s.name}>
                  <Td className="py-2 pr-4 font-medium text-paper-100">{s.name}</Td>
                  <Td className="px-4 py-2 text-right tabular-nums text-paper-300">{s.runs}</Td>
                  <Td className="px-4 py-2 text-right tabular-nums text-paper-300">
                    {formatPercent(s.successRate)}
                  </Td>
                  <Td className="py-2 pl-4 text-right tabular-nums text-paper-300">
                    {formatCost(s.avgCostUsd)}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

type SkillFilter = 'all' | 'builtIn' | 'custom' | 'external' | 'unverified' | 'inactive';

const SKILL_FILTERS: { label: string; value: SkillFilter }[] = [
  { label: 'All skills', value: 'all' },
  { label: 'Built-in', value: 'builtIn' },
  { label: 'Custom', value: 'custom' },
  { label: 'Imported', value: 'external' },
  { label: 'Unverified', value: 'unverified' },
  { label: 'Inactive', value: 'inactive' },
];

function matchesFilter(skill: Skill, filter: SkillFilter): boolean {
  switch (filter) {
    case 'builtIn':
      return skill.isBuiltIn;
    case 'custom':
      return !(skill.isBuiltIn || skill.externalSource);
    case 'external':
      return Boolean(skill.externalSource);
    case 'unverified':
      return !(skill.isVerified || skill.isBuiltIn);
    case 'inactive':
      return !skill.isActive;
    default:
      return true;
  }
}

type Tab = 'skills' | 'external';

export default function StudioSkillsPage() {
  const isAdmin = useHasRole('ADMIN');
  const [tab, setTab] = useState<Tab>('skills');
  const [newOpen, setNewOpen] = useState(false);
  const [viewTarget, setViewTarget] = useState<Skill | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const deleteSkill = useDeleteSkill();
  const { data: skills, isLoading, isError, isFetching, error: loadError, refetch } = useSkills();
  const update = useUpdateSkill();
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SkillFilter>('all');
  const q = query.trim().toLowerCase();
  const visibleSkills = (skills ?? []).filter(
    (sk) =>
      matchesFilter(sk, filter) &&
      (!q || `${sk.name} ${sk.description ?? ''}`.toLowerCase().includes(q))
  );
  const filtering = Boolean(q) || filter !== 'all';

  // A skill that agents use is not switched off without a confirmation.
  const [deactivateTarget, setDeactivateTarget] = useState<Skill | null>(null);

  function requestToggle(skill: Skill) {
    if (skill.isActive && skill.usedByCount > 0) {
      setDeactivateTarget(skill);
      return;
    }
    void handleToggleActive(skill);
  }

  async function handleToggleActive(skill: Skill) {
    setToggleError(null);
    setTogglingId(skill.id);
    try {
      await update.mutateAsync({ id: skill.id, isActive: !skill.isActive });
    } catch (err) {
      setToggleError(errMsg(err, `Failed to update "${skill.name}"`));
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            <Icon name="plus" size={14} />
            Create skill
          </Button>
        }
        subtitle="Reusable prompt-fragment instructions injected into an agent's system prompt. Attach them to agents in the Agent library. Every text change is saved as a revision you can compare and restore."
        title="Skill library"
      />

      {isAdmin && (
        <TabBar
          active={tab}
          ariaLabel="Skill library views"
          idPrefix="skills"
          onChange={setTab}
          tabs={[
            { id: 'skills', label: 'Skills' },
            { id: 'external', label: 'External sources' },
          ]}
        />
      )}

      {isAdmin && tab === 'external' && (
        <div {...tabPanelProps('skills', 'external')}>
          <SkillSourcesTab />
        </div>
      )}

      {tab === 'skills' && (
        <div {...(isAdmin ? tabPanelProps('skills', 'skills') : {})}>
          <Card className="p-4 sm:p-6">
            <Toolbar
              end={
                skills && skills.length > 0 ? (
                  <span className="text-xs text-paper-500 tabular-nums">
                    {filtering
                      ? `${visibleSkills.length} of ${skills.length} skills`
                      : `${skills.length} skills`}
                  </span>
                ) : null
              }
            >
              <SearchInput
                label="Search skills"
                onChange={setQuery}
                placeholder="Search skills…"
                value={query}
              />
              <Select
                aria-label="Filter skills"
                className="h-8 w-full text-[13px] sm:w-44"
                onChange={(v) => setFilter(v as SkillFilter)}
                options={SKILL_FILTERS}
                value={filter}
              />
            </Toolbar>
            {toggleError && (
              <Alert className="mb-4" variant="error">
                {toggleError}
              </Alert>
            )}
            <QueryBoundary
              error={loadError}
              isError={isError}
              isFetching={isFetching}
              isLoading={false}
              label="skills"
              onRetry={() => void refetch()}
            >
              {isLoading ? (
                <SkeletonRows rows={8} />
              ) : !skills?.length ? (
                <EmptyState
                  action={
                    <Button onClick={() => setNewOpen(true)} size="sm" variant="primary">
                      Create skill
                    </Button>
                  }
                  hint="A skill is a reusable block of instructions. Attach it to an agent to shape how that agent reasons."
                  icon="skills"
                  title="No skills yet"
                />
              ) : visibleSkills.length === 0 ? (
                <EmptyState
                  action={
                    <Button
                      onClick={() => {
                        setQuery('');
                        setFilter('all');
                      }}
                      size="sm"
                    >
                      Clear filters
                    </Button>
                  }
                  hint="Try a different search or filter."
                  icon="search"
                  title="No skills match"
                />
              ) : (
                <Table stacked>
                  <THead>
                    <Th className="pl-0" variant="plain">
                      Skill
                    </Th>
                    <Th variant="plain">Source</Th>
                    <Th variant="plain">Status</Th>
                    <Th align="right" variant="plain">
                      Used by
                    </Th>
                    <Th variant="plain">Active</Th>
                    <Th className="pr-0" variant="plain">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </THead>
                  <tbody>
                    {visibleSkills.map((skill) => (
                      <TRow hover key={skill.id}>
                        <Td className="py-2.5 pr-4 sm:max-w-md" primary>
                          <button
                            className={cn(
                              'max-w-full truncate rounded-sm text-left font-medium text-paper-100 hover:text-ember-300',
                              FOCUS_RING
                            )}
                            onClick={() => setViewTarget(skill)}
                            type="button"
                          >
                            {visibleText(skill.name)}
                          </button>
                          <div className="mt-0.5 line-clamp-2 text-xs text-paper-500 sm:line-clamp-1">
                            {visibleOrNull(skill.description) ?? 'No description'}
                          </div>
                        </Td>
                        <Td className="px-4 py-2.5" label="Source">
                          <div className="flex flex-wrap items-center gap-1 max-sm:justify-end">
                            {skill.isBuiltIn && <Badge tone="neutral">Built-in</Badge>}
                            {skill.origin && <OriginBadge origin={skill.origin} />}
                            <ExternalBadge source={skill.externalSource} />
                            {!(skill.isBuiltIn || skill.origin || skill.externalSource) && (
                              <span className="text-xs text-paper-400">Custom</span>
                            )}
                          </div>
                        </Td>
                        <Td className="px-4 py-2.5" label="Status">
                          <div className="flex flex-wrap items-center gap-1 max-sm:justify-end">
                            {skill.isVerified && (
                              <Badge dot tone="moss">
                                Verified
                              </Badge>
                            )}
                            {!skill.isVerified && !skill.isBuiltIn && (
                              <Badge dot tone="amber">
                                Unverified
                              </Badge>
                            )}
                            {!skill.isBuiltIn && (
                              <Badge className="tabular-nums" tone="neutral" variant="outline">
                                Rev {skill.currentRevision}
                              </Badge>
                            )}
                          </div>
                        </Td>
                        <Td
                          align="right"
                          className="px-4 py-2.5 text-paper-300 tabular-nums"
                          label="Used by"
                        >
                          <span
                            title={skill.usedBy.length > 0 ? skill.usedBy.join(', ') : 'No agents'}
                          >
                            {skill.usedByCount}
                            <span className="text-paper-500">
                              {' '}
                              {skill.usedByCount === 1 ? 'agent' : 'agents'}
                            </span>
                          </span>
                        </Td>
                        <Td className="px-4 py-2.5" label="Active">
                          <ToggleSwitch
                            ariaLabel={`Active: ${visibleText(skill.name)}`}
                            checked={skill.isActive}
                            disabled={togglingId === skill.id}
                            onChange={() => requestToggle(skill)}
                          />
                        </Td>
                        <Td align="right" className="py-2.5 pl-4">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              aria-label={`Open ${visibleText(skill.name)}`}
                              onClick={() => setViewTarget(skill)}
                              size="sm"
                            >
                              Open
                            </Button>
                            {!skill.isBuiltIn && (
                              <ActionMenu
                                items={[
                                  {
                                    icon: 'trash',
                                    id: 'delete',
                                    label: 'Delete skill',
                                    onAction: () => setDeleteTarget(skill),
                                    tone: 'danger',
                                  },
                                ]}
                                label={`More actions for ${visibleText(skill.name)}`}
                              />
                            )}
                          </div>
                        </Td>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </QueryBoundary>
          </Card>
        </div>
      )}

      {tab === 'skills' && <EffectivenessCard />}

      <SkillFormModal onClose={() => setNewOpen(false)} open={newOpen} />
      <ConfirmModal
        confirmLabel="Deactivate"
        dangerous
        message={`Agents stop receiving "${visibleText(deactivateTarget?.name ?? '')}" while it is inactive. ${deactivateTarget ? (usageText(deactivateTarget) ?? '') : ''} This takes effect in runs already in progress too.`}
        onClose={() => setDeactivateTarget(null)}
        onConfirm={async () => {
          if (deactivateTarget) {
            await handleToggleActive(deactivateTarget);
          }
        }}
        open={deactivateTarget !== null}
        pendingLabel="Deactivating…"
        title={`Deactivate "${visibleText(deactivateTarget?.name ?? '')}"?`}
      />
      <SkillDetailModal onClose={() => setViewTarget(null)} skill={viewTarget} />
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={
          deleteTarget
            ? `Delete "${visibleText(deleteTarget.name)}" and remove it from every agent that uses it. ${usageText(deleteTarget) ?? 'No agent uses it.'} This cannot be undone.`
            : ''
        }
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await deleteSkill.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete "${visibleText(deleteTarget?.name ?? '')}"?`}
      />
    </div>
  );
}
