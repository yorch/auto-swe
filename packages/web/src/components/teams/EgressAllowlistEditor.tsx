'use client';

import { AllowlistEditor } from '@/components/teams/AllowlistEditor';
import { useTeamEgressAllowlist, useUpdateTeamEgressAllowlist } from '@/hooks/useTeams';

export function EgressAllowlistEditor({ teamId }: { teamId: string }) {
  const { data, isLoading } = useTeamEgressAllowlist(teamId);
  const update = useUpdateTeamEgressAllowlist(teamId);
  return (
    <AllowlistEditor
      description={
        <>
          Shell steps with <code className="text-paper-300">network: egress</code> may only reach
          these hostnames via DNS. One hostname per line, e.g.{' '}
          <code className="text-paper-300">registry.npmjs.org</code> or{' '}
          <code className="text-paper-300">*.github.com</code>. Wildcard entries are informational
          only — DNS filtering applies to exact lookups; IP-direct connections are not blocked.
        </>
      }
      isLoading={isLoading}
      items={data?.egressAllowlist}
      onSave={(list) => update.mutateAsync(list)}
      placeholder="registry.npmjs.org"
      saving={update.isPending}
      title="Egress hostname allowlist"
    />
  );
}
