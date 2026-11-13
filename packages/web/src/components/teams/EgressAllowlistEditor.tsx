'use client';

import { AllowlistEditor } from '@/components/teams/AllowlistEditor';
import { useTeamEgressAllowlist, useUpdateTeamEgressAllowlist } from '@/hooks/useTeams';

export function EgressAllowlistEditor({ teamId }: { teamId: string }) {
  const { data, isLoading, isError } = useTeamEgressAllowlist(teamId);
  const update = useUpdateTeamEgressAllowlist(teamId);
  return (
    <div className="space-y-4">
      <section aria-label="platform baseline, always included">
        <h3 className="text-sm font-medium">platform baseline, always included</h3>
        {isLoading ? (
          <p>Loading platform baseline…</p>
        ) : isError ? (
          <p role="alert">Unable to load platform baseline.</p>
        ) : data?.baselineAllowlist?.length ? (
          <ul className="text-sm text-paper-300">
            {data?.baselineAllowlist?.map((host) => (
              <li key={host}>
                <code>{host}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>No platform baseline hosts configured.</p>
        )}
        <p className="text-sm text-paper-400">
          Included when an allowlist is enforced. Open with an empty team list remains unrestricted.
          Managed by platform or organization administrators.
        </p>
      </section>
      <AllowlistEditor
        description={
          <>
            Egress-enabled workspaces and steps use these hostnames together with the platform
            baseline through the HTTP(S) proxy. One hostname per line, e.g.{' '}
            <code className="text-paper-300">registry.npmjs.org</code> or{' '}
            <code className="text-paper-300">*.github.com</code>. Restricted policy also locks
            direct traffic to platform proxies and the repository git host; proxy destinations must
            match the enforced list.
          </>
        }
        isLoading={isLoading}
        items={data?.egressAllowlist}
        onSave={(list) => update.mutateAsync(list)}
        placeholder="registry.npmjs.org"
        saving={update.isPending}
        title="Egress hostname allowlist"
        warnings={update.data?.warnings}
      />
    </div>
  );
}
