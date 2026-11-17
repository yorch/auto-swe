'use client';

import { useState } from 'react';
import { HooksBadge } from '@/components/harnessProfiles/HooksBadge';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  type StrandedAgent,
  type TeamPlugin,
  useDisableTeamPlugin,
  useEnableTeamPlugin,
  useTeamPlugins,
} from '@/hooks/useTeamPlugins';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';

const READ_ONLY_REASON = 'Only a team admin can enable or disable plugins for the team.';

/**
 * The plugins a platform admin approved, and whether this team has enabled each. A team enables a
 * plugin before its admins can bind it on the team's agent overrides. Every member sees the list;
 * the switches work for the team's ADMINs alone (a team role, not a platform one). Disabling
 * fails new runs of the agents that still name the plugin closed, and lists them here.
 */
export function TeamPluginsSection({ canManage, teamId }: { teamId: string; canManage: boolean }) {
  const { data: plugins, isLoading, isError, isFetching, error, refetch } = useTeamPlugins(teamId);
  const enable = useEnableTeamPlugin(teamId);
  const disable = useDisableTeamPlugin(teamId);
  const [confirm, setConfirm] = useState<TeamPlugin | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stranded, setStranded] = useState<{ plugin: string; agents: StrandedAgent[] } | null>(
    null
  );

  async function turnOn(p: TeamPlugin) {
    setNotice(null);
    setStranded(null);
    try {
      await enable.mutateAsync(p.name);
    } catch (err) {
      setNotice(errMsg(err, 'Failed to enable the plugin'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plugins</CardTitle>
      </CardHeader>
      <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-paper-400">
        Plugins are approved by a platform admin. Enable one for this team before a team admin binds
        it on the team’s agent overrides.
        {!canManage && ` ${READ_ONLY_REASON}`}
      </p>
      {notice && (
        <Alert className="mb-4" variant="error">
          {notice}
        </Alert>
      )}
      {stranded && (
        <Alert className="mb-4" variant="warning">
          “{visibleText(stranded.plugin)}” is disabled for the team.{' '}
          {stranded.agents.length === 0 ? (
            'No team agent names it.'
          ) : (
            <>
              New runs of these agents fail closed until it is enabled again or the binding is
              removed:
              <ul className="mt-1 list-disc pl-5">
                {stranded.agents.map((a) => (
                  <li key={`${a.key}:${a.version}`}>
                    <span className="font-mono text-xs">{visibleText(a.key)}</span> v{a.version}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Alert>
      )}
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="plugins"
        onRetry={() => void refetch()}
        rows={3}
      >
        {!plugins?.length ? (
          <EmptyState
            bordered
            hint="A platform admin approves plugins under Admin, Plugins."
            icon="package"
            title="No plugins available"
          />
        ) : (
          <ul className="divide-y divide-ink-600">
            {plugins.map((p) => (
              <li className="flex flex-wrap items-start justify-between gap-3 py-3" key={p.name}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-paper-100">{visibleText(p.name)}</span>
                    <span className="text-xs text-paper-500">v{p.latestVersion}</span>
                    <HooksBadge enabled={p.hooksEnabled} />
                    {p.status === 'DISABLED' && (
                      <Badge dot tone="warning">
                        Disabled by platform admin
                      </Badge>
                    )}
                    {p.enabled && p.status !== 'DISABLED' && (
                      <Badge dot tone="success">
                        Enabled
                      </Badge>
                    )}
                  </div>
                  {p.description && (
                    <p className="mt-0.5 text-sm text-paper-400">{visibleText(p.description)}</p>
                  )}
                  {p.enabled && p.enabledAt && (
                    <p className="mt-0.5 text-xs text-paper-500">
                      Enabled {formatDate(p.enabledAt)}
                    </p>
                  )}
                </div>
                {p.status === 'DISABLED' ? (
                  <Button
                    aria-label={`Withdraw enablement of ${visibleText(p.name)}`}
                    disabled={!canManage || disable.isPending}
                    onClick={() => setConfirm(p)}
                    size="sm"
                    title={
                      canManage
                        ? 'A platform admin disabled this plugin; withdraw the team’s enablement'
                        : READ_ONLY_REASON
                    }
                    variant="secondary"
                  >
                    Withdraw enablement
                  </Button>
                ) : (
                  <ToggleSwitch
                    ariaLabel={`Enable ${visibleText(p.name)} for this team`}
                    checked={p.enabled}
                    disabled={!canManage || enable.isPending || disable.isPending}
                    onChange={() => (p.enabled ? setConfirm(p) : void turnOn(p))}
                    title={
                      canManage
                        ? p.enabled
                          ? 'Disable for the team'
                          : 'Enable for the team'
                        : READ_ONLY_REASON
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <ConfirmModal
        confirmLabel="Disable plugin"
        dangerous
        message="Agents of this team that still name the plugin fail closed on new runs, with an error naming it. Runs already in flight keep the version they pinned. The agents affected are listed afterwards."
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) {
            return;
          }
          setNotice(null);
          const res = await disable.mutateAsync(confirm.name);
          setStranded({ agents: res.strandedAgents, plugin: confirm.name });
        }}
        open={confirm !== null}
        pendingLabel="Disabling…"
        title={`Disable "${confirm ? visibleText(confirm.name) : ''}" for this team?`}
      />
    </Card>
  );
}
