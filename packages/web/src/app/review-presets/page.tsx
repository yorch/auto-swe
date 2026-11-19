'use client';

import { useState } from 'react';
import { ReviewPresetsView } from '@/components/ReviewPresetsView';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { useCanOnTeams } from '@/hooks/useCan';
import { useEffectivePermissions } from '@/hooks/useEffectivePermissions';
import { useTeams } from '@/hooks/useTeams';

export default function TeamReviewPresetsPage() {
  const teams = useTeams();
  const canManage = useCanOnTeams('team.codereview.manage', teams.data ?? []);
  const permissionsKnown = useEffectivePermissions().data !== undefined;
  const [selected, setSelected] = useState('');
  const options = (teams.data ?? []).filter((t) => canManage(t.id));
  const teamId = options.find((t) => t.id === selected)?.id ?? options[0]?.id;
  // Until the permissions are known the list is empty for lack of data, not of teams.
  const emptyNote = permissionsKnown ? <p>No teams you lead are available.</p> : null;
  return (
    <div className="space-y-4">
      <QueryBoundary {...teams} label="teams" onRetry={() => teams.refetch()}>
        <Select
          label="Team"
          onChange={setSelected}
          options={options.map((t) => ({ label: t.name, value: t.id }))}
          value={teamId ?? ''}
        />
        {teamId ? <ReviewPresetsView key={teamId} teamId={teamId} /> : emptyNote}
      </QueryBoundary>
    </div>
  );
}
