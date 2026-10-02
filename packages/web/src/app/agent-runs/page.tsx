'use client';

import { AgentRunForm } from '@/components/agentRuns/AgentRunForm';
import { PageHeader } from '@/components/ui/PageHeader';
import { navLabel } from '@/lib/navigation';

export default function AgentRunsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        chapter="§ Agents"
        subtitle="Give a library agent a task on one repository. It works in a throwaway checkout; by default nothing leaves it. Nothing is ever merged for you."
        title={navLabel('/agent-runs')}
      />
      <AgentRunForm />
    </div>
  );
}
