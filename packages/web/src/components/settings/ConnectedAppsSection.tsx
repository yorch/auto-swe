'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { type McpGrant, useMcpGrants, useRevokeMcpGrant } from '@/hooks/useMcpGrants';
import { describeRedirect, MCP_SCOPE_WRITE } from '@/lib/mcpConsent';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { SettingsListRow, SettingsSection } from './SettingsSection';

function hostsOf(grant: McpGrant): string {
  return [...new Set(grant.redirectUris.map((uri) => describeRedirect(uri).host))].join(', ');
}

/**
 * The MCP clients the user has authorised, with the one action that matters: take access
 * back. Disconnecting is immediate and durable (the app cannot refresh its way back in); the
 * app has to be authorised again, with a new consent. Hidden while MCP is off and nothing is
 * connected, since there is then nothing to show or to do.
 */
export function ConnectedAppsSection() {
  const { data, error, isError, isFetching, refetch, isLoading } = useMcpGrants();
  const revoke = useRevokeMcpGrant();
  const [target, setTarget] = useState<McpGrant | null>(null);

  const grants = data?.data ?? [];
  if (data && !data.mcp.enabled && grants.length === 0) {
    return null;
  }

  return (
    <>
      <SettingsSection
        description="MCP clients, such as coding agents, you have allowed to act on your behalf."
        icon="plug"
        id="connected-apps"
        title="Connected apps"
      >
        {isLoading ? (
          <SkeletonRows rows={2} />
        ) : (
          <QueryBoundary
            compact
            error={error}
            isError={isError}
            isFetching={isFetching}
            isLoading={false}
            label="apps"
            onRetry={() => void refetch()}
          >
            {grants.length === 0 ? (
              <EmptyState
                hint="When you approve an MCP client, such as a coding agent, it appears here so you can disconnect it later."
                icon="plug"
                title="No connected apps"
              />
            ) : (
              <ul className="divide-y divide-ink-600">
                {grants.map((grant) => {
                  const canWrite = grant.scopes.includes(MCP_SCOPE_WRITE);
                  return (
                    <SettingsListRow
                      action={
                        <Button onClick={() => setTarget(grant)} size="sm" variant="danger">
                          Disconnect
                        </Button>
                      }
                      detail={
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="break-all font-mono text-xs text-paper-400">
                            {hostsOf(grant)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{canWrite ? 'Read and write' : 'Read only'}</span>
                          <span aria-hidden="true">·</span>
                          <span title={formatDate(grant.grantedAt)}>
                            Connected {formatRelativeTime(grant.grantedAt)}
                          </span>
                        </span>
                      }
                      key={grant.clientId}
                      leading={<Icon name="plug" size={16} />}
                      status={
                        <>
                          <Badge
                            title="The app named itself; auto-swe has not checked it"
                            tone="amber"
                            variant="outline"
                          >
                            Unverified
                          </Badge>
                          {canWrite && (
                            <Badge tone="ember" variant="outline">
                              Can write
                            </Badge>
                          )}
                        </>
                      }
                      title={grant.clientName ?? 'Unnamed app'}
                    />
                  );
                })}
              </ul>
            )}
          </QueryBoundary>
        )}
      </SettingsSection>

      <ConfirmModal
        confirmLabel="Disconnect"
        dangerous
        message="The app loses access right away, including any session it keeps open. To use it again you will approve it again."
        onClose={() => setTarget(null)}
        onConfirm={async () => {
          // Awaited so ConfirmModal keeps the dialog open and shows a failure.
          if (target) {
            await revoke.mutateAsync(target.clientId);
          }
        }}
        open={target !== null}
        pendingLabel="Disconnecting…"
        title={`Disconnect ${target?.clientName ?? 'this app'}?`}
      />
    </>
  );
}
