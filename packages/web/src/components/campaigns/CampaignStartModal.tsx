'use client';

import { campaignTextProblem } from '@auto-swe/shared/lib/campaignOutcome';
import { recipeSupportsCheck } from '@auto-swe/shared/lib/campaignRecipes';
import { BUDGET_TIERS, CAMPAIGN_DESCRIPTION_MAX_LENGTH } from '@auto-swe/shared/types/workflow';
import { type FormEvent, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput } from '@/components/ui/Toolbar';
import { type CreateCampaignBody, useCreateCampaign } from '@/hooks/useCampaigns';
import { useCanOnTeams } from '@/hooks/useCan';
import { useRepositories } from '@/hooks/useRepositories';
import { useAuthoringTeams } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';
import { CAMPAIGN_FORM_LIMITS, RECIPE_OPTIONS } from './campaignDisplay';

/** The gateway's ceiling for one launch; the owning team's own limit may be lower. */
const MAX_REPOS = 200;
const NAME_MAX = 120;

type FieldRange = { label: string; max: number; min: number };

/** An optional whole number within `range`; empty is fine. The message names the field. */
function wholeNumberProblem(raw: string, range: FieldRange): string | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < range.min || value > range.max) {
    return `${range.label} must be a whole number from ${range.min} to ${range.max}.`;
  }
  return null;
}

/** Values the form opens with (a recorded proposal); every field is optional and editable. */
export interface CampaignStartInitialValues {
  description?: string;
  name?: string;
  ownerTeamId?: string;
  packageName?: string;
  plan?: 'UNIFORM' | 'PLANNED';
  recipeRef?: string;
  repoIds?: string[];
  targetVersion?: string;
}

/**
 * Starts a campaign. The route needs LEAD or ADMIN on the owning team and on the team that owns
 * every repository, whatever the platform role, so the choices are limited to those; the gateway
 * still decides. `onStarted` receives the campaign's page path.
 */
export function CampaignStartModal({
  initialValues,
  onClose,
  onStarted,
  open,
}: {
  initialValues?: CampaignStartInitialValues;
  onClose: () => void;
  onStarted: (path: string) => void;
  open: boolean;
}) {
  return (
    <Modal
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Apply one planned change to many repositories of one organization. Every result is a draft pull request for a person to review and merge, unless its repository is in auto mode, where GitHub may merge a qualifying low-risk one once a person has marked it ready."
      title="Start a campaign"
    >
      {open && <StartForm initialValues={initialValues} onClose={onClose} onStarted={onStarted} />}
    </Modal>
  );
}

function StartForm({
  initialValues,
  onClose,
  onStarted,
}: {
  initialValues?: CampaignStartInitialValues;
  onClose: () => void;
  onStarted: (path: string) => void;
}) {
  const create = useCreateCampaign();
  const { isLoading: teamsLoading, teams } = useAuthoringTeams();
  const { data: allRepos = [] } = useRepositories({ limit: 100 });
  // A campaign needs `team.launch.multi-repo` on the team that owns each repository it names.
  const canLaunchOn = useCanOnTeams(
    'team.launch.multi-repo',
    useMemo(() => allRepos.map((r) => ({ id: r.team.id })), [allRepos])
  );
  const [name, setName] = useState(initialValues?.name ?? '');
  const [description, setDescription] = useState(initialValues?.description ?? '');
  const [ownerChoice, setOwnerChoice] = useState(initialValues?.ownerTeamId ?? '');
  const [recipeRef, setRecipeRef] = useState(initialValues?.recipeRef ?? '');
  const [packageName, setPackageName] = useState(initialValues?.packageName ?? '');
  const [targetVersion, setTargetVersion] = useState(initialValues?.targetVersion ?? '');
  const [budget, setBudget] = useState('');
  const [maxParallel, setMaxParallel] = useState('');
  const [plan, setPlan] = useState<'UNIFORM' | 'PLANNED'>(initialValues?.plan ?? 'UNIFORM');
  const [gate, setGate] = useState<'OPENED' | 'MERGED'>('OPENED');
  const [scopeKind, setScopeKind] = useState<'' | 'TEAM' | 'ORG'>('');
  const [maxOpenPullRequests, setMaxOpenPullRequests] = useState('');
  const [staleAfterDays, setStaleAfterDays] = useState('');
  const [rescanIntervalHours, setRescanIntervalHours] = useState('');
  const [budgetUsd, setBudgetUsd] = useState('');
  const [lifetimeDays, setLifetimeDays] = useState('');
  const [pickedIds, setPickedIds] = useState<string[]>(initialValues?.repoIds ?? []);
  const [repoFilter, setRepoFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  // A single choice is the choice.
  const ownerTeamId = ownerChoice || (teams.length === 1 ? (teams[0]?.id ?? '') : '');
  const ownerTeam = teams.find((t) => t.id === ownerTeamId);
  const orgByTeam = new Map(teams.map((t) => [t.id, t.orgId]));
  // A planned campaign takes its work from the planner, so it has no recipe: nothing to check
  // against, and so nothing to discover or verify with.
  const planned = plan === 'PLANNED';
  const recipe = planned ? '' : recipeRef;
  const canCheck = recipeSupportsCheck(recipe);

  // Git repositories in the owning team's organization, owned by a team the caller may start a
  // campaign for.
  const isGit = (r: (typeof allRepos)[number]) => r.type === 'git_repo' && r.isActive;
  const eligible = allRepos.filter((r) => {
    if (!isGit(r)) {
      return false;
    }
    if (!canLaunchOn(r.team.id)) {
      return false;
    }
    const org = orgByTeam.get(r.team.id);
    return !ownerTeam || org === undefined || org === ownerTeam.orgId;
  });
  const eligibleIds = new Set(eligible.map((r) => r.id));
  const repoIds = pickedIds.filter((id) => eligibleIds.has(id));
  const term = repoFilter.trim().toLowerCase();
  const shown = term
    ? eligible.filter((r) => `${r.organizationName}/${r.repoName}`.toLowerCase().includes(term))
    : eligible;

  function toggle(id: string) {
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function problem(): string | null {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return 'Give the campaign a name.';
    }
    const nameProblem = campaignTextProblem(trimmedName);
    if (nameProblem) {
      return `Name: ${nameProblem}`;
    }
    if (!description.trim()) {
      return 'Write the brief: it is the agent’s instructions and the pull request text.';
    }
    const briefProblem = campaignTextProblem(description);
    if (briefProblem) {
      return `Brief: ${briefProblem}`;
    }
    if (!ownerTeamId) {
      return 'Choose the owning team.';
    }
    if (recipe && (!packageName.trim() || !targetVersion.trim())) {
      return 'A recipe needs a package name and an exact target version.';
    }
    if (repoIds.length === 0) {
      return 'Pick at least one repository.';
    }
    if (repoIds.length > MAX_REPOS) {
      return `A campaign names at most ${MAX_REPOS} repositories.`;
    }
    if (maxParallel && !/^[1-9]\d*$/.test(maxParallel.trim())) {
      return 'Parallel repositories must be a whole number of at least 1.';
    }
    const limits = CAMPAIGN_FORM_LIMITS;
    const fieldProblem =
      wholeNumberProblem(maxOpenPullRequests, limits.maxOpenPullRequests) ??
      wholeNumberProblem(staleAfterDays, limits.staleAfterDays) ??
      (canCheck ? wholeNumberProblem(rescanIntervalHours, limits.rescanIntervalHours) : null) ??
      wholeNumberProblem(lifetimeDays, limits.lifetimeDays);
    if (fieldProblem) {
      return fieldProblem;
    }
    const budget = budgetUsd.trim();
    if (
      budget &&
      (!/^\d+(\.\d{1,2})?$/.test(budget) ||
        Number(budget) <= 0 ||
        Number(budget) > limits.budgetUsd.max)
    ) {
      return `Monthly budget must be an amount in dollars above 0 and up to ${limits.budgetUsd.max.toLocaleString('en-US')}.`;
    }
    return null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = problem();
    if (found) {
      setError(found);
      return;
    }
    setError(null);
    const body: CreateCampaignBody = {
      description,
      name: name.trim(),
      ownerTeamId,
      plan,
      repoIds,
      ...(planned ? { gate } : {}),
      ...(recipe
        ? {
            recipe: {
              params: { packageName: packageName.trim(), targetVersion: targetVersion.trim() },
              ref: recipe,
            },
          }
        : {}),
      // Discovery needs the recipe's check; without one the target list is fixed.
      ...(canCheck && scopeKind
        ? {
            scope:
              scopeKind === 'TEAM'
                ? { id: ownerTeamId, kind: 'TEAM' as const }
                : { kind: 'ORG' as const },
          }
        : {}),
      ...(maxParallel ? { maxParallel: Number(maxParallel.trim()) } : {}),
      ...(maxOpenPullRequests ? { maxOpenPullRequests: Number(maxOpenPullRequests.trim()) } : {}),
      ...(staleAfterDays ? { staleAfterDays: Number(staleAfterDays.trim()) } : {}),
      ...(canCheck && rescanIntervalHours
        ? { rescanIntervalHours: Number(rescanIntervalHours.trim()) }
        : {}),
      ...(budgetUsd.trim() ? { budgetUsd: Number(budgetUsd.trim()) } : {}),
      ...(lifetimeDays ? { lifetimeDays: Number(lifetimeDays.trim()) } : {}),
      ...(budget ? { budget: budget as (typeof BUDGET_TIERS)[number] } : {}),
    };
    try {
      const res = await create.mutateAsync(body);
      onStarted(res.detailPath || `/campaigns/${encodeURIComponent(res.campaignId)}`);
    } catch (err) {
      setError(errMsg(err, 'Could not start the campaign'));
    }
  }

  return (
    <form className="space-y-5" onSubmit={(e) => void submit(e)}>
      <Input
        label="Name"
        maxLength={NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        placeholder="Raise lodash to 4.17.21"
        required
        value={name}
      />
      <Select
        disabled={teamsLoading || teams.length === 0}
        hint="The team that owns the campaign and may cancel it. You must lead it."
        label="Owning team"
        onChange={setOwnerChoice}
        options={teams.map((t) => ({ label: `${t.name} (${t.orgName})`, value: t.id }))}
        placeholder={teamsLoading ? 'Loading teams…' : 'Choose a team'}
        required
        value={ownerTeamId}
      />
      <Textarea
        hint="The agent’s instructions for repositories the recipe cannot change, and the pull request text. Nobody can answer the agent’s questions."
        id="campaign-brief"
        label="Brief"
        maxLength={CAMPAIGN_DESCRIPTION_MAX_LENGTH}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Raise lodash to 4.17.21 everywhere it is used and keep the tests passing."
        required
        rows={5}
        value={description}
      />
      <RadioGroup
        legend="Work"
        name="campaign-plan"
        onChange={setPlan}
        options={[
          {
            description: 'The brief and the recipe apply to every repository alike.',
            label: 'Same change everywhere',
            value: 'UNIFORM',
          },
          {
            description:
              'The planner splits the brief into one brief per repository and an order between them. You review the plan and confirm before anything starts.',
            label: 'Planned per repository',
            value: 'PLANNED',
          },
        ]}
        value={plan}
      />
      {planned && (
        <RadioGroup
          legend="A repository may start when"
          name="campaign-gate"
          onChange={setGate}
          options={[
            {
              description: 'The repositories it depends on have a draft pull request open.',
              label: 'An upstream draft pull request is open',
              value: 'OPENED',
            },
            {
              description:
                'Slower: every step in a chain waits for review and CI, so a long chain takes days rather than hours.',
              label: 'An upstream pull request has merged and its check passed',
              value: 'MERGED',
            },
          ]}
          value={gate}
        />
      )}
      {!planned && (
        <Select
          hint={
            recipeRef
              ? canCheck
                ? 'This recipe can check a repository: the campaign can find repositories that start to match and confirm that a merge fixed one.'
                : 'This recipe only makes the change: no discovery of new repositories and no verification of merges. Choose an @2 recipe for those.'
              : 'A recipe makes the change with a script, no model involved. Without one the agent makes it. Recipes ending @2 also enable discovery and verification of merges; @1 recipes do not.'
          }
          label="Recipe"
          onChange={setRecipeRef}
          options={RECIPE_OPTIONS.map((o) => ({
            description: o.description,
            label: o.label,
            value: o.value,
          }))}
          value={recipeRef}
        />
      )}
      {recipe && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            hint={recipe.startsWith('go-') ? 'A Go module path.' : 'An npm package name.'}
            label="Package name"
            onChange={(e) => setPackageName(e.target.value)}
            placeholder={recipe.startsWith('go-') ? 'github.com/pkg/errors' : 'lodash'}
            required
            value={packageName}
          />
          <Input
            hint="An exact version, not a range or a tag."
            label="Target version"
            onChange={(e) => setTargetVersion(e.target.value)}
            placeholder={recipe.startsWith('go-') ? 'v1.9.0' : '4.17.21'}
            required
            value={targetVersion}
          />
        </div>
      )}
      <fieldset>
        <legend className="float-left mb-2 flex w-full flex-wrap items-end justify-between gap-2">
          <span className="label-mono">Repositories</span>
          <span className="text-xs text-paper-500">
            <span className="tabular text-paper-300">{repoIds.length}</span> selected
          </span>
        </legend>
        <div className="clear-both space-y-2">
          {eligible.length > 8 && (
            <SearchInput
              className="sm:w-full"
              label="Filter repositories"
              onChange={setRepoFilter}
              placeholder="Filter repositories…"
              value={repoFilter}
            />
          )}
          <div className="max-h-60 overflow-y-auto rounded-lg border border-ink-500/70 bg-ink-900/40">
            {shown.map((r) => (
              <Checkbox
                checked={repoIds.includes(r.id)}
                className="border-b border-ink-600 px-3 py-2.5 last:border-b-0 hover:bg-ink-700/40"
                key={r.id}
                label={
                  <span className="text-paper-100">
                    {r.organizationName}/{r.repoName}
                  </span>
                }
                onChange={() => toggle(r.id)}
              />
            ))}
            {shown.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-paper-500">
                {eligible.length
                  ? 'No repositories match this filter'
                  : 'No repositories available to you'}
              </p>
            )}
          </div>
          <p className="text-xs text-paper-500">
            Only GitHub repositories of the owning team’s organization, owned by a team you lead,
            are listed. Each pull request is opened as you.
          </p>
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          hint="Repositories in flight at once. Leave empty for the team’s limit; it is never raised above it."
          inputMode="numeric"
          label="Parallel repositories"
          onChange={(e) => setMaxParallel(e.target.value)}
          placeholder="Team default"
          value={maxParallel}
        />
        <Select
          hint="The budget tier of each repository’s run."
          label="Budget per repository"
          onChange={setBudget}
          options={[
            { label: 'Default', value: '' },
            ...BUDGET_TIERS.map((tier) => ({ label: tier.toLowerCase(), value: tier })),
          ]}
          value={budget}
        />
      </div>
      <details className="rounded-lg border border-ink-500/70 px-4 py-3">
        <summary className="cursor-pointer text-sm text-paper-200">Limits and schedule</summary>
        <div className="mt-4 space-y-4">
          {canCheck && (
            <Select
              hint="Look for other repositories that need the change, and add them when the person this campaign runs as may start work in them. Others are listed as found, not started."
              label="Find more repositories in"
              onChange={(value) => setScopeKind(value as '' | 'TEAM' | 'ORG')}
              options={[
                { label: 'Nowhere: the list above is fixed', value: '' },
                { label: 'The owning team’s repositories', value: 'TEAM' },
                { label: 'The whole organization', value: 'ORG' },
              ]}
              value={scopeKind}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              hint="No new repository starts while this many draft pull requests of this campaign await review. Empty for the team default."
              inputMode="numeric"
              label="Open pull requests at most"
              onChange={(e) => setMaxOpenPullRequests(e.target.value)}
              placeholder="Team default"
              value={maxOpenPullRequests}
            />
            <Input
              hint="A draft open this long is flagged as stale. Nothing is closed. Empty for the team default."
              inputMode="numeric"
              label="Stale after (days)"
              onChange={(e) => setStaleAfterDays(e.target.value)}
              placeholder="Team default"
              value={staleAfterDays}
            />
            {canCheck && (
              <Input
                hint="How often satisfied repositories are checked again. Empty for the team default."
                inputMode="numeric"
                label="Re-check every (hours)"
                onChange={(e) => setRescanIntervalHours(e.target.value)}
                placeholder="Team default"
                value={rescanIntervalHours}
              />
            )}
            <Input
              hint="What the campaign’s runs may spend in a month; at the cap it pauses. Empty for no cap of its own."
              inputMode="decimal"
              label="Monthly budget (USD)"
              onChange={(e) => setBudgetUsd(e.target.value)}
              placeholder="No cap"
              value={budgetUsd}
            />
            <Input
              hint="How long it may keep watching for new repositories and regressions. Empty for the default."
              inputMode="numeric"
              label="Lifetime (days)"
              onChange={(e) => setLifetimeDays(e.target.value)}
              placeholder="Default"
              value={lifetimeDays}
            />
          </div>
        </div>
      </details>
      {error && <Alert>{error}</Alert>}
      <ModalFooter
        isPending={create.isPending}
        onCancel={onClose}
        pendingLabel="Starting…"
        submitLabel="Start campaign"
      />
    </form>
  );
}
