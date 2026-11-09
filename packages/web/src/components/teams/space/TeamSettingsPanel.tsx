'use client';

import type { TeamSummary } from '@auto-swe/shared/types/api';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { KnowledgeBaseLinksPanel } from '@/components/knowledgeBases/KnowledgeBaseLinksSection';
import { EgressAllowlistEditor } from '@/components/teams/EgressAllowlistEditor';
import { EventEndpointsCard } from '@/components/teams/EventEndpointsCard';
import { ServicePrincipalsSection } from '@/components/teams/ServicePrincipalsSection';
import { ShellAllowlistEditor } from '@/components/teams/ShellAllowlistEditor';
import { TeamAgentLibrarySection } from '@/components/teams/TeamAgentLibrarySection';
import { TeamCallbackEndpointsSection } from '@/components/teams/TeamCallbackEndpointsSection';
import { TeamFormModal } from '@/components/teams/TeamFormModal';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { Textarea } from '@/components/ui/Textarea';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { useTeam, useUpdateTeam } from '@/hooks/useTeams';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { api } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { hasRole } from '@/lib/roles';
import { teamPermissions } from '@/lib/teamPermissions';
import { useAuthStore } from '@/stores/authStore';

type SettingsTab = 'general' | 'service-principals' | 'automation' | 'sandbox';

/** Persona text beyond this many characters is probably unintended; shown as a counter, not enforced. */
const PERSONA_SOFT_LIMIT = 4000;

/** One repository line in the side rail: `org/repo` and a trailing note or badge. */
function RepoLine({ name, trailing }: { name: string; trailing: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="shrink-0 text-paper-500" name="repositories" size={14} />
        <span className="truncate font-mono text-sm text-paper-200" title={name}>
          {name}
        </span>
      </span>
      <span className="shrink-0">{trailing}</span>
    </li>
  );
}

/**
 * A team's configuration: its details, repositories, persona, service principals, event
 * endpoints and agents, and sandbox policy. Offered to a team LEAD or ADMIN and to a platform
 * ADMIN; each section still shows only what `teamPermissions` says the caller may change.
 */
export function TeamSettingsPanel({ team: summary }: { team: TeamSummary }) {
  const id = summary.id;
  const { data: team, error, isError, isFetching, isLoading, refetch } = useTeam(id);
  const platformRole = useAuthStore((s) => s.user?.role);
  const {
    canManageMembers: canManage,
    canEditAllowlists,
    canManageTeamAgents,
    canManageCallbacks,
  } = teamPermissions(platformRole, summary.myRole);
  const updateTeam = useUpdateTeam(id);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { params: urlParams, update: updateUrl } = useUrlFilters();

  const [editing, setEditing] = useState(false);
  const [personaInput, setPersonaInput] = usePrefilledField(team?.defaultPersonaPrompt);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const [confirmClearPersona, setConfirmClearPersona] = useState(false);
  const [personaSaved, setPersonaSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleSavePersona() {
    setPersonaError(null);
    setPersonaSaved(false);
    const next = personaInput.trim();
    // Save never clears: emptying the text is not a deliberate delete, so it
    // is refused and the confirmed "Clear persona" action is the only way.
    if (!next) {
      setPersonaError('Enter a persona to save, or use "Clear persona" to remove the current one.');
      return;
    }
    try {
      await updateTeam.mutateAsync({ defaultPersonaPrompt: next });
      setPersonaSaved(true);
    } catch (e) {
      setPersonaError(errMsg(e, 'Failed to update persona'));
    }
  }

  if (isLoading || isError || !team) {
    return (
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="team settings"
        onRetry={() => void refetch()}
        shape="detail"
      />
    );
  }

  const personaUnchanged = personaInput.trim() === (team.defaultPersonaPrompt ?? '').trim();
  const repositories = team.repositories ?? [];
  const shared = team.sharedRepositories ?? [];
  const isPlatformAdmin = hasRole(platformRole, 'ADMIN');

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: 'General' },
    ...(canManage ? [{ id: 'service-principals' as const, label: 'Service principals' }] : []),
    { id: 'automation', label: 'Events & agents' },
    ...(canEditAllowlists ? [{ id: 'sandbox' as const, label: 'Sandbox policy' }] : []),
  ];
  // The section lives in the URL so it can be linked to and survives a reload.
  const rawTab = urlParams.get('tab');
  const tab: SettingsTab = tabs.some((t) => t.id === rawTab) ? (rawTab as SettingsTab) : 'general';
  const setTab = (next: SettingsTab) => updateUrl({ tab: next === 'general' ? null : next });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-paper-400">
          {team.description ||
            'Repositories, persona, service principals, sandbox allowlists and agent overrides.'}
          <span className="mt-1 block font-mono text-xs text-paper-500">{team.slug}</span>
        </p>
        {canManage && (
          <Button onClick={() => setEditing(true)} variant="secondary">
            <Icon name="edit" size={14} />
            Edit team
          </Button>
        )}
      </div>

      <TabBar
        active={tab}
        ariaLabel="Settings sections"
        idPrefix="team-settings"
        onChange={setTab}
        tabs={tabs}
      />

      {tab === 'general' && (
        <div className="space-y-6" {...tabPanelProps('team-settings', 'general')}>
          <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
            <Card>
              <CardHeader className="mb-2">
                <CardTitle>Repositories</CardTitle>
                <span className="text-xs text-paper-500 tabular-nums">{repositories.length}</span>
              </CardHeader>
              {repositories.length === 0 ? (
                <EmptyState
                  className="py-6"
                  hint={
                    canManage ? (
                      <>
                        Add one from{' '}
                        <Link
                          className="text-paper-100 underline decoration-paper-600 underline-offset-2 hover:decoration-current"
                          href="/connections"
                        >
                          Connections
                        </Link>
                        .
                      </>
                    ) : (
                      'A team lead or admin can add repositories.'
                    )
                  }
                  icon="repositories"
                  title="No repositories yet"
                />
              ) : (
                <ul className="divide-y divide-ink-600">
                  {repositories.map((r) => (
                    <RepoLine
                      key={r.id}
                      name={`${r.organizationName}/${r.repoName}`}
                      trailing={
                        <Badge dot tone={r.isActive ? 'success' : 'muted'} variant="text">
                          {r.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      }
                    />
                  ))}
                </ul>
              )}
            </Card>

            {shared.length > 0 && (
              <Card>
                <CardHeader className="mb-2">
                  <CardTitle>Shared with this team</CardTitle>
                  <span className="text-xs text-paper-500 tabular-nums">{shared.length}</span>
                </CardHeader>
                <ul className="divide-y divide-ink-600">
                  {shared.map((r) => (
                    <RepoLine
                      key={r.id}
                      name={`${r.organizationName}/${r.repoName}`}
                      trailing={<span className="text-xs text-paper-500">from {r.team.name}</span>}
                    />
                  ))}
                </ul>
              </Card>
            )}
          </div>

          {canManage && (
            <Card>
              <CardHeader className="mb-1">
                <CardTitle>Default persona</CardTitle>
                {!team.defaultPersonaPrompt && (
                  <Badge tone="muted" variant="outline">
                    Not set
                  </Badge>
                )}
              </CardHeader>
              <p className="mb-4 text-sm text-paper-400">
                Team-wide default persona for every channel assistant. A channel can override it.
              </p>
              <div className="space-y-4">
                {personaError ? <Alert variant="error">{personaError}</Alert> : null}
                <Textarea
                  className="font-sans text-sm"
                  label="Persona"
                  mono={false}
                  onChange={(e) => {
                    setPersonaInput(e.target.value);
                    setPersonaSaved(false);
                  }}
                  placeholder="You are a helpful assistant for this team…"
                  value={personaInput}
                />
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span
                    aria-live="polite"
                    className={`mr-auto text-xs ${personaInput.length > PERSONA_SOFT_LIMIT ? 'text-warning-400' : 'text-paper-500'}`}
                  >
                    {personaSaved && personaUnchanged
                      ? 'Persona saved. '
                      : personaUnchanged
                        ? ''
                        : 'Unsaved changes. '}
                    {personaInput.length.toLocaleString()} characters
                    {personaInput.length > PERSONA_SOFT_LIMIT
                      ? ' — long personas cost tokens on every message'
                      : ''}
                  </span>
                  {team.defaultPersonaPrompt && (
                    <Button
                      disabled={updateTeam.isPending}
                      onClick={() => setConfirmClearPersona(true)}
                      variant="ghost"
                    >
                      Clear persona
                    </Button>
                  )}
                  <Button
                    disabled={updateTeam.isPending || personaUnchanged}
                    onClick={handleSavePersona}
                    variant="primary"
                  >
                    {updateTeam.isPending ? 'Saving…' : 'Save persona'}
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {isPlatformAdmin && (
            <Card className="border-danger-400/30">
              <CardHeader className="mb-1">
                <CardTitle>Delete team</CardTitle>
              </CardHeader>
              <p className="mb-4 text-sm text-paper-400">
                Deactivates this team so it no longer appears in the directory. Its audit history is
                kept.
              </p>
              <Button onClick={() => setConfirmDelete(true)} variant="danger-solid">
                Delete team
              </Button>
            </Card>
          )}
        </div>
      )}

      {tab === 'service-principals' && canManage && (
        <div {...tabPanelProps('team-settings', 'service-principals')}>
          <ServicePrincipalsSection
            repositories={[...repositories.filter((r) => r.isActive), ...shared].map((r) => ({
              id: r.id,
              label: `${r.organizationName}/${r.repoName}`,
            }))}
            teamId={id}
          />
        </div>
      )}

      {tab === 'automation' && (
        <div className="space-y-6" {...tabPanelProps('team-settings', 'automation')}>
          <EventEndpointsCard team={{ id, name: team.name }} />
          <KnowledgeBaseLinksPanel
            canManage={canManage}
            target={{ scope: 'TEAM', teamId: id }}
            teamId={id}
          />
          {canManageTeamAgents && <TeamAgentLibrarySection teamId={id} />}
          {canManageCallbacks && (
            <TeamCallbackEndpointsSection isPlatformAdmin={isPlatformAdmin} teamId={id} />
          )}
        </div>
      )}

      {tab === 'sandbox' && canEditAllowlists && (
        <div
          className="grid grid-cols-1 gap-6 lg:grid-cols-2"
          {...tabPanelProps('team-settings', 'sandbox')}
        >
          <ShellAllowlistEditor teamId={id} />
          <EgressAllowlistEditor teamId={id} />
        </div>
      )}

      <TeamFormModal
        mode={{
          initial: { description: team.description, name: team.name },
          kind: 'edit',
          teamId: id,
        }}
        onClose={() => setEditing(false)}
        open={editing}
      />
      <ConfirmModal
        confirmLabel="Delete team"
        confirmText={team.name}
        dangerous
        message={`${team.name} is deactivated: it disappears from the team directory and its members lose access through it. Type the team name to confirm.`}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await api.delete(`/api/v1/teams/${id}`);
          await queryClient.invalidateQueries({ queryKey: ['teams'] });
          router.push('/admin/teams');
        }}
        open={confirmDelete}
        title="Delete team?"
      />
      <ConfirmModal
        confirmLabel="Clear"
        dangerous
        message="The team-wide default persona is removed; channels that set their own persona are unaffected. The current text is not kept."
        onClose={() => setConfirmClearPersona(false)}
        onConfirm={async () => {
          await updateTeam.mutateAsync({ defaultPersonaPrompt: null });
        }}
        open={confirmClearPersona}
        title="Clear persona?"
      />
    </div>
  );
}
