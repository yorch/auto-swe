'use client';

import { PageHeader } from '@/components/ui/PageHeader';
import { CanaryForm } from '@/components/workflow/CanaryForm';
import { ConsolidationForm } from '@/components/workflow/ConsolidationForm';
import { RevalidationForm } from '@/components/workflow/RevalidationForm';
import { WorkflowDefaultsForm } from '@/components/workflow/WorkflowDefaultsForm';

export default function AdminWorkflowPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="System-wide defaults applied to every new work request. These are platform-wide — for the knobs a team or channel can override, see Settings."
        title="Admin — Workflow defaults"
      />
      <WorkflowDefaultsForm />
      <ConsolidationForm />
      <RevalidationForm />
      <CanaryForm />
    </div>
  );
}
