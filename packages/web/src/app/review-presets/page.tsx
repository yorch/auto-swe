'use client';

import { useState } from 'react';
import { ReviewPresetsView } from '@/components/ReviewPresetsView';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { useLedTeamIds, useTeams } from '@/hooks/useTeams';
import { useAuthStore } from '@/stores/authStore';

export default function TeamReviewPresetsPage() {
  const teams = useTeams();
  const led = useLedTeamIds();
  const admin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const [selected, setSelected] = useState('');
  const options = (teams.data ?? []).filter((t) => admin || led?.has(t.id));
  const teamId = options.find((t) => t.id === selected)?.id ?? options[0]?.id;
  // Until the led teams are known the list is empty for lack of data, not of teams.
  const emptyNote = !admin && led === null ? null : <p>No teams you lead are available.</p>;
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
