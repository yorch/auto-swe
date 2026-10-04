'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { type McpGrant, useMcpGrants, useRevokeMcpGrant } from '@/hooks/useMcpGrants';
import { describeRedirect, MCP_SCOPE_WRITE } from '@/lib/mcpConsent';
import { formatRelativeTime } from '@/lib/utils';

function hostsOf(grant: McpGrant): string {
  return [...new Set(grant.redirectUris.map((uri) => describeRedirect(uri).host))].join(', ');
}

/**
 * The MCP clients the user has authorised, with the one action that matters: take access
 * back. Disconnecting is immediate and durable (the app cannot refresh its way back in); the
 * app has to be authorised again, with a new consent. Hidden while MCP is off and nothing is
 * connected, since there is then nothing to show or to do.
 */
export function ConnectedAppsSection({ number }: { number?: string }) {
  const { data, error, isError, refetch, isLoading } = useMcpGrants();
  const revoke = useRevokeMcpGrant();
  const [target, setTarget] = useState<McpGrant | null>(null);

  const grants = data?.data ?? [];
  if (data && !data.mcp.enabled && grants.length === 0) {
    return null;
  }

  return (
    <>
      <SectionHeader
        hint="MCP clients you have authorised"
        number={number}
        title="Connected apps"
      />
      <Card variant="inset">
        <QueryBoundary
          compact
          error={error}
          isError={isError}
          isLoading={isLoading}
          label="apps"
          onRetry={() => void refetch()}
        >
          {grants.length === 0 ? (
            <EmptyState
              hint="An MCP client you connect to auto-swe, such as a coding agent, appears here."
              title="No connected apps"
            />
          ) : (
            <ul className="divide-y divide-ink-600">
              {grants.map((grant) => (
                <li className="flex items-center justify-between gap-4 py-3" key={grant.clientId}>
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-3">
                      <span className="text-sm text-paper-100">
                        {grant.clientName ?? 'Unnamed app'}
                      </span>
                      <Badge tone="amber" uppercase variant="text">
                        unverified
                      </Badge>
                      {grant.scopes.includes(MCP_SCOPE_WRITE) && (
                        <Badge tone="ember" uppercase variant="text">
                          can write
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 font-mono text-[10px] uppercase tracking-wider text-paper-500">
                      <span>{hostsOf(grant)}</span>
                      <span>
                        · {grant.scopes.includes(MCP_SCOPE_WRITE) ? 'read + write' : 'read'}
                      </span>
                      <span>· connected {formatRelativeTime(grant.grantedAt)}</span>
                    </div>
                  </div>
                  <Button onClick={() => setTarget(grant)} size="sm" variant="danger">
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </Card>

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
