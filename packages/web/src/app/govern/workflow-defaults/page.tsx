'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { CanaryForm } from '@/components/workflow/CanaryForm';
import { ConsolidationForm } from '@/components/workflow/ConsolidationForm';
import { RevalidationForm } from '@/components/workflow/RevalidationForm';
import { WorkflowDefaultsForm } from '@/components/workflow/WorkflowDefaultsForm';
import { navLabel } from '@/lib/navigation';

export default function GovernWorkflowPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Govern"
        subtitle={
          <>
            System-wide defaults applied to every new work request. For the settings a team or
            channel can override, see{' '}
            <Link className="text-ember-400 hover:underline" href="/govern/platform-settings">
              Platform settings
            </Link>
            .
          </>
        }
        title={navLabel('/govern/workflow-defaults')}
      />
      <WorkflowDefaultsForm />
      <ConsolidationForm />
      <RevalidationForm />
      <CanaryForm />
    </div>
  );
}
