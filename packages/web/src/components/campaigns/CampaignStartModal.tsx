'use client';

import { campaignTextProblem } from '@auto-swe/shared/lib/campaignOutcome';
import { BUDGET_TIERS, CAMPAIGN_DESCRIPTION_MAX_LENGTH } from '@auto-swe/shared/types/workflow';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput } from '@/components/ui/Toolbar';
import { type CreateCampaignBody, useCreateCampaign } from '@/hooks/useCampaigns';
import { useHasRole } from '@/hooks/useHasRole';
import { useRepositories } from '@/hooks/useRepositories';
import { useAuthoringTeams, useLedTeamIds } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';
import { RECIPE_OPTIONS } from './campaignDisplay';

/** The gateway's ceiling for one launch; the owning team's own limit may be lower. */
const MAX_REPOS = 200;
const NAME_MAX = 120;

/**
 * Starts a campaign. The route needs LEAD or ADMIN on the owning team and on the team that owns
 * every repository, whatever the platform role, so the choices are limited to those; the gateway
 * still decides. `onStarted` receives the campaign's page path.
 */
export function CampaignStartModal({
  onClose,
  onStarted,
  open,
}: {
  onClose: () => void;
  onStarted: (path: string) => void;
  open: boolean;
}) {
  return (
    <Modal
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Apply one planned change to many repositories of one organization. Every result is a draft pull request for a person to review and merge."
      title="Start a campaign"
    >
      {open && <StartForm onClose={onClose} onStarted={onStarted} />}
    </Modal>
  );
}

function StartForm({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (path: string) => void;
}) {
  const create = useCreateCampaign();
  const { isLoading: teamsLoading, teams } = useAuthoringTeams();
  const ledTeamIds = useLedTeamIds();
  const isAdmin = useHasRole('ADMIN');
  const { data: allRepos = [] } = useRepositories({ limit: 100 });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ownerChoice, setOwnerChoice] = useState('');
  const [recipeRef, setRecipeRef] = useState('');
  const [packageName, setPackageName] = useState('');
  const [targetVersion, setTargetVersion] = useState('');
  const [budget, setBudget] = useState('');
  const [maxParallel, setMaxParallel] = useState('');
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [repoFilter, setRepoFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  // A single choice is the choice.
  const ownerTeamId = ownerChoice || (teams.length === 1 ? (teams[0]?.id ?? '') : '');
  const ownerTeam = teams.find((t) => t.id === ownerTeamId);
  const orgByTeam = new Map(teams.map((t) => [t.id, t.orgId]));

  // Git repositories in the owning team's organization, owned by a team the caller leads. A
  // platform ADMIN may use any team's.
  const isGit = (r: (typeof allRepos)[number]) => r.type === 'git_repo' && r.isActive;
  const eligible = allRepos.filter((r) => {
    if (!isGit(r)) {
      return false;
    }
    if (!isAdmin && !ledTeamIds?.has(r.team.id)) {
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
    if (recipeRef && (!packageName.trim() || !targetVersion.trim())) {
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
      repoIds,
      ...(recipeRef
        ? {
            recipe: {
              params: { packageName: packageName.trim(), targetVersion: targetVersion.trim() },
              ref: recipeRef,
            },
          }
        : {}),
      ...(maxParallel ? { maxParallel: Number(maxParallel.trim()) } : {}),
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
      <Select
        hint="A recipe makes the change with a script, no model involved. Without one the agent makes it."
        label="Recipe"
        onChange={setRecipeRef}
        options={RECIPE_OPTIONS.map((o) => ({
          description: o.description,
          label: o.label,
          value: o.value,
        }))}
        value={recipeRef}
      />
      {recipeRef && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            hint={recipeRef.startsWith('go-') ? 'A Go module path.' : 'An npm package name.'}
            label="Package name"
            onChange={(e) => setPackageName(e.target.value)}
            placeholder={recipeRef.startsWith('go-') ? 'github.com/pkg/errors' : 'lodash'}
            required
            value={packageName}
          />
          <Input
            hint="An exact version, not a range or a tag."
            label="Target version"
            onChange={(e) => setTargetVersion(e.target.value)}
            placeholder={recipeRef.startsWith('go-') ? 'v1.9.0' : '4.17.21'}
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
