'use client';

import { useMemo, useState } from 'react';
import { SettingRow } from '@/components/settings/SettingRow';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import {
  type ScopeSelection,
  type SettingView,
  useClearConfigSetting,
  useConfigSettings,
  useSetConfigSetting,
} from '@/hooks/useConfigSettings';
import { useTeams } from '@/hooks/useTeams';

/**
 * Every configurable knob, rendered from the registry definitions rather than
 * hand-written per setting — adding a knob costs a definition in `shared`, not
 * a form field here.
 *
 * The scope picker is the point of the page: the same list re-resolves at the
 * chosen scope, so an operator can see what a team actually gets and change it
 * there, instead of only being able to move the platform-wide value.
 */

const GROUP_TITLES: Record<string, string> = {
  channel: 'Channel assistant',
  memory: 'Semantic memory',
  workflow: 'Workflow interpreter',
  workspace: 'Agent workspace',
};

const GROUP_BLURBS: Record<string, string> = {
  channel:
    'How proactive the Slack assistant is and how much context it reads per turn. Overridable per channel, so one noisy channel can be tuned without touching the rest.',
  memory: 'Relevance thresholds for what semantic memory surfaces.',
  workflow:
    'Bounds on how far one run may expand. Frozen when a run starts, so changing them affects new runs only.',
  workspace:
    'Container images and isolation for agent workspaces, plus worker capacity. Mostly platform-wide.',
};

export default function AdminSettingsPage() {
  const [scope, setScope] = useState<ScopeSelection['scope']>('GLOBAL');
  const [teamId, setTeamId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const teams = useTeams();

  // A TEAM view needs a team chosen before it means anything; until then keep
  // showing the platform-wide values rather than an empty page.
  const selection: ScopeSelection = useMemo(
    () => (scope === 'TEAM' && teamId ? { scope: 'TEAM', teamId } : { scope: 'GLOBAL' }),
    [scope, teamId]
  );

  const settings = useConfigSettings(selection);
  const setSetting = useSetConfigSetting(selection);
  const clearSetting = useClearConfigSetting(selection);

  const grouped = useMemo(() => {
    const byGroup = new Map<string, SettingView[]>();
    for (const setting of settings.data ?? []) {
      const list = byGroup.get(setting.group) ?? [];
      list.push(setting);
      byGroup.set(setting.group, list);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [settings.data]);

  const busy = setSetting.isPending || clearSetting.isPending;
  const awaitingTeam = scope === 'TEAM' && !teamId;

  function messageFrom(err: unknown): string {
    return err instanceof Error ? err.message : 'The change could not be saved.';
  }

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="Operator policy that used to be compiled into the worker. Values shown are what this scope resolves to; each row says where its value came from."
        title="Admin — Settings"
      />

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap gap-4">
          <Select
            label="View settings for"
            onChange={(e) => setScope(e.target.value as ScopeSelection['scope'])}
            value={scope}
          >
            <option value="GLOBAL">Platform-wide</option>
            <option value="TEAM">A team</option>
          </Select>
          {scope === 'TEAM' && (
            <Select label="Team" onChange={(e) => setTeamId(e.target.value)} value={teamId}>
              <option value="">Choose a team…</option>
              {(teams.data ?? []).map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        {awaitingTeam && (
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-paper-500">
            Showing platform-wide values until a team is chosen.
          </p>
        )}
      </Card>

      {error && <Alert variant="error">{error}</Alert>}

      {settings.isLoading && <LoadingState />}
      {settings.isError && (
        <Alert variant="error">Settings could not be loaded. Refresh to try again.</Alert>
      )}

      {grouped.map(([group, items]) => (
        <Card key={group}>
          <CardHeader>
            <CardTitle>{GROUP_TITLES[group] ?? group}</CardTitle>
          </CardHeader>
          {GROUP_BLURBS[group] && (
            <p className="-mt-2 mb-4 max-w-prose text-xs leading-relaxed text-paper-400">
              {GROUP_BLURBS[group]}
            </p>
          )}
          {items.map((setting) => (
            <SettingRow
              busy={busy}
              // Decided by the server, which is the only side that knows the
              // grants. Re-deriving it from the role here could only ever see
              // the floor, so a lead holding a grant would be shown a disabled
              // control for a key they are entitled to change.
              canWriteHere={setting.canWrite}
              key={setting.key}
              onClear={() => {
                setError(null);
                clearSetting.mutate(setting.key, {
                  onError: (err) => setError(messageFrom(err)),
                });
              }}
              onSave={(value) => {
                setError(null);
                setSetting.mutate(
                  { key: setting.key, value },
                  { onError: (err) => setError(messageFrom(err)) }
                );
              }}
              scope={selection.scope}
              setting={setting}
            />
          ))}
        </Card>
      ))}
    </div>
  );
}
