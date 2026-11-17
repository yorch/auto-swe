'use client';

import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import type { HarnessProfileBoundAgent, ProfileEnablement } from '@/hooks/useHarnessProfiles';
import { formatDate } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';

/** Agents (the newest version of each lineage) bound to the plugin; stranded ones fail closed. */
export function BoundAgents({ agents }: { agents: HarnessProfileBoundAgent[] }) {
  const stranded = agents.filter((a) => a.stranded);
  return (
    <section aria-label="Bound agents" className="space-y-2">
      <h3 className="text-sm font-semibold text-paper-100">Bound agents</h3>
      {agents.length === 0 ? (
        <p className="text-xs text-paper-500">No agent is bound to this plugin.</p>
      ) : (
        <>
          {stranded.length > 0 && (
            <Alert announce={false} variant="warning">
              {stranded.length} team agent{stranded.length === 1 ? '' : 's'} bound to this plugin
              belong{stranded.length === 1 ? 's' : ''} to a team that has not enabled it. New runs
              of {stranded.length === 1 ? 'that agent' : 'those agents'} fail closed until the team
              enables the plugin or the binding is removed.
            </Alert>
          )}
          <ul className="space-y-1 text-sm">
            {agents.map((a) => (
              <li
                className="flex flex-wrap items-center gap-2"
                key={`${a.scope}:${a.teamId ?? ''}:${a.key}`}
              >
                <span className="font-mono text-xs text-paper-200">{visibleText(a.key)}</span>
                <Badge tone="neutral" variant="outline">
                  {a.scope === 'GLOBAL' ? 'platform-wide' : a.scope.toLowerCase().replace('_', ' ')}
                </Badge>
                <span className="text-xs text-paper-500">v{a.version}</span>
                {a.stranded && (
                  <Badge dot tone="danger">
                    Stranded
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Teams that enabled the plugin, so a team admin may bind it on their overrides. */
export function EnabledTeams({
  enablements,
  count,
}: {
  enablements: ProfileEnablement[] | undefined;
  count: number | undefined;
}) {
  return (
    <section aria-label="Enabled teams" className="space-y-2">
      <h3 className="text-sm font-semibold text-paper-100">
        Enabled teams <span className="font-normal text-paper-500">({count ?? 0})</span>
      </h3>
      {!enablements?.length ? (
        <p className="text-xs text-paper-500">No team has enabled this plugin.</p>
      ) : (
        <ul className="space-y-1 text-sm text-paper-300">
          {enablements.map((e) => (
            <li key={e.teamId}>
              {visibleText(e.teamName)}{' '}
              <span className="text-xs text-paper-500">enabled {formatDate(e.enabledAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
