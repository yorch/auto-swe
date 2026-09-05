'use client';

import { AllowlistEditor } from '@/components/teams/AllowlistEditor';
import { useTeamShellAllowlist, useUpdateTeamShellAllowlist } from '@/hooks/useTeams';

export function ShellAllowlistEditor({ teamId }: { teamId: string }) {
  const { data, isLoading } = useTeamShellAllowlist(teamId);
  const update = useUpdateTeamShellAllowlist(teamId);
  return (
    <AllowlistEditor
      description={
        <>
          Workflow shell steps may only use Docker images from this list (in addition to the team's
          repo executor images). One image per line, e.g.{' '}
          <code className="text-paper-300">ghcr.io/acme/ci-tools:latest</code>. Leave empty to
          disallow custom shell-step images entirely.
        </>
      }
      isLoading={isLoading}
      items={data?.shellImageAllowlist}
      onSave={(list) => update.mutateAsync(list)}
      placeholder="ghcr.io/acme/ci-tools:latest"
      saving={update.isPending}
      title="Shell-step image allowlist"
    />
  );
}
