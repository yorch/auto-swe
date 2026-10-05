'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { SettingRow, type SettingRowStatus } from '@/components/settings/SettingRow';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { useOrganizationDirectory } from '@/hooks/useAdmin';
import {
  type ScopeSelection,
  type SettingView,
  useClearConfigSetting,
  useConfigSettings,
  useSetConfigSetting,
} from '@/hooks/useConfigSettings';
import { useHasRole } from '@/hooks/useHasRole';
import { useSlackChannels } from '@/hooks/useSlackChannels';
import { useTeams } from '@/hooks/useTeams';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { errMsg } from '@/lib/errors';
import { navLabel } from '@/lib/navigation';

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
  repoDependency: 'Repo dependency graph',
  workflow: 'Workflow interpreter',
  workspace: 'Agent workspace',
};

const GROUP_BLURBS: Record<string, string> = {
  channel:
    'How proactive the Slack assistant is and how much context it reads per turn. Overridable per channel, so one noisy channel can be tuned without touching the rest.',
  memory: 'Relevance thresholds for what semantic memory surfaces.',
  repoDependency:
    'How confidently an LLM-inferred repo-to-repo dependency edge must be evidenced before it is promoted straight to active instead of waiting for a human confirm.',
  workflow:
    'Bounds on how far one run may expand. Frozen when a run starts, so changing them affects new runs only.',
  workspace:
    'Container images and isolation for agent workspaces, plus worker capacity. Mostly platform-wide.',
};

type ViewScope = 'GLOBAL' | 'ORGANIZATION' | 'TEAM' | 'CHANNEL';

const SCOPE_OPTIONS: { label: string; value: ViewScope }[] = [
  { label: 'Platform-wide', value: 'GLOBAL' },
  { label: 'An organization', value: 'ORGANIZATION' },
  { label: 'A team', value: 'TEAM' },
  { label: 'A Slack channel', value: 'CHANNEL' },
];

/** The id parameter each narrower scope carries in the URL and in the settings query. */
const SCOPE_ID_PARAM = {
  CHANNEL: 'channelId',
  ORGANIZATION: 'orgId',
  TEAM: 'teamId',
} as const;

export default function GovernSettingsPage() {
  const { params, update } = useUrlFilters();
  const isAdmin = useHasRole('ADMIN');
  // The viewed scope lives in the URL so a view can be linked to and survives a reload.
  const rawScope = params.get('scope');
  const scope: ViewScope =
    rawScope === 'ORGANIZATION' || rawScope === 'TEAM' || rawScope === 'CHANNEL'
      ? rawScope
      : 'GLOBAL';
  const scopeId = scope === 'GLOBAL' ? '' : (params.get(SCOPE_ID_PARAM[scope]) ?? '');
  const [rowStatus, setRowStatus] = useState<Record<string, SettingRowStatus>>({});

  const teams = useTeams();
  const orgs = useOrganizationDirectory();
  const channels = useSlackChannels();

  const showScope = (nextScope: ViewScope, id = '') => {
    setRowStatus({});
    update({
      channelId: nextScope === 'CHANNEL' ? id : null,
      orgId: nextScope === 'ORGANIZATION' ? id : null,
      scope: nextScope === 'GLOBAL' ? null : nextScope,
      teamId: nextScope === 'TEAM' ? id : null,
    });
  };

  // A narrower view needs its team / organization / channel chosen before it means
  // anything; until then keep showing the platform-wide values rather than an empty page.
  const selection: ScopeSelection = useMemo(
    () =>
      scope !== 'GLOBAL' && scopeId
        ? ({ scope, [SCOPE_ID_PARAM[scope]]: scopeId } as ScopeSelection)
        : { scope: 'GLOBAL' },
    [scope, scopeId]
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

  const viewKey = selection.scope === 'GLOBAL' ? 'GLOBAL' : `${selection.scope}:${scopeId}`;
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;
  // Row status belongs to the view it was made in. Reset it whenever the view changes — through
  // the picker or through back/forward navigation, which changes the URL without `showScope`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset is keyed on the view itself
  useEffect(() => {
    setRowStatus({});
  }, [viewKey]);

  const awaitingChoice = scope !== 'GLOBAL' && !scopeId;

  // Each row tracks its own save, so one slow or failing write neither freezes
  // the page nor reports against the wrong setting.
  // `mutateAsync` per call: per-call `mutate` callbacks live on one observer and TanStack
  // drops those of any earlier call when a later one starts, leaving that row "Saving…".
  const track = (key: string, run: () => Promise<unknown>) => {
    const startedAt = viewKey;
    // A save that settles after the view changed belongs to the old scope: drop it.
    const stillHere = () => viewKeyRef.current === startedAt;
    setRowStatus((prev) => ({ ...prev, [key]: { phase: 'saving' } }));
    run().then(
      () => stillHere() && setRowStatus((prev) => ({ ...prev, [key]: { phase: 'saved' } })),
      (err: unknown) =>
        stillHere() &&
        setRowStatus((prev) => ({
          ...prev,
          [key]: { message: errMsg(err, 'The change could not be saved.'), phase: 'error' },
        }))
    );
  };

  // Where a value came from, when this page can show that scope: the platform-wide view
  // always, and the narrower scope currently being viewed.
  const sourceHrefFor = (source: SettingView['source']): string | undefined => {
    if (source === 'GLOBAL') {
      return '/govern/platform-settings';
    }
    if (scope !== 'GLOBAL' && source === scope && scopeId) {
      return `/govern/platform-settings?scope=${scope}&${SCOPE_ID_PARAM[scope]}=${scopeId}`;
    }
    return undefined;
  };

  return (
    <div className="space-y-8">
      <PageHeader
        subtitle="Operator policy for agents, channels and workflows. Values shown are what this scope resolves to; each row says where its value came from."
        title={navLabel('/govern/platform-settings')}
      />

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap gap-4">
          <Select
            label="View settings for"
            onChange={(v) => showScope(v as ViewScope)}
            options={SCOPE_OPTIONS}
            value={scope}
          />
          {scope === 'TEAM' && (
            <Combobox
              label="Team"
              onChange={(id) => showScope('TEAM', id)}
              options={(teams.data ?? []).map((team) => ({ label: team.name, value: team.id }))}
              placeholder="Choose a team…"
              value={scopeId}
            />
          )}
          {scope === 'ORGANIZATION' && (
            <Combobox
              label="Organization"
              onChange={(id) => showScope('ORGANIZATION', id)}
              options={(orgs.data ?? []).map((org) => ({ label: org.name, value: org.id }))}
              placeholder="Choose an organization…"
              value={scopeId}
            />
          )}
          {scope === 'CHANNEL' && (
            <Combobox
              label="Slack channel"
              onChange={(id) => showScope('CHANNEL', id)}
              options={(channels.data ?? []).map((c) => ({
                label: c.name ? `#${c.name}` : 'Unnamed channel',
                value: c.id,
              }))}
              placeholder="Choose a channel…"
              value={scopeId}
            />
          )}
        </div>
        {awaitingChoice && (
          <p className="mt-3 text-xs text-paper-500">
            Showing platform-wide values until you choose one.
          </p>
        )}
      </Card>

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
              // Decided by the server, which is the only side that knows the
              // grants. Re-deriving it from the role here could only ever see
              // the floor, so a lead holding a grant would be shown a disabled
              // control for a key they are entitled to change.
              canWriteHere={setting.canWrite}
              grantsHref={isAdmin ? '/govern/config-grants' : undefined}
              key={setting.key}
              onClear={() => track(setting.key, () => clearSetting.mutateAsync(setting.key))}
              onEdit={() =>
                setRowStatus((prev) => {
                  if (!prev[setting.key] || prev[setting.key].phase === 'saving') {
                    return prev;
                  }
                  const { [setting.key]: _cleared, ...rest } = prev;
                  return rest;
                })
              }
              onSave={(value) =>
                track(setting.key, () => setSetting.mutateAsync({ key: setting.key, value }))
              }
              scope={selection.scope}
              scopeKey={viewKey}
              setting={setting}
              sourceHref={sourceHrefFor(setting.source)}
              status={rowStatus[setting.key]}
            />
          ))}
        </Card>
      ))}
    </div>
  );
}
