'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { CanaryForm } from '@/components/workflow/CanaryForm';
import { ConsolidationForm } from '@/components/workflow/ConsolidationForm';
import { RevalidationForm } from '@/components/workflow/RevalidationForm';
import { WorkflowDefaultsForm } from '@/components/workflow/WorkflowDefaultsForm';
import { navLabel } from '@/lib/navigation';
import { FOCUS_RING } from '@/lib/utils';

/** The forms on this page, in order, for the "On this page" index. */
const SECTIONS: { id: string; label: string; hint: string }[] = [
  { hint: 'Branch prefix, PR templates, team, budgets', id: 'defaults', label: 'Run defaults' },
  { hint: 'When lessons are merged', id: 'consolidation', label: 'Consolidation' },
  { hint: 'When eval datasets re-run', id: 'revalidation', label: 'Re-validation' },
  { hint: 'A/B traffic split', id: 'canary', label: 'Canary' },
];

function Section({ children, id }: { children: ReactNode; id: string }) {
  return (
    <section className="scroll-mt-6" id={id}>
      {children}
    </section>
  );
}

export default function GovernWorkflowPage() {
  return (
    <div>
      <PageHeader
        subtitle={
          <>
            System-wide defaults applied to every new work request. Each section saves on its own.
            For the settings a team or channel can override, see{' '}
            <Link className="text-ember-400 hover:underline" href="/govern/platform-settings">
              Platform settings
            </Link>
            .
          </>
        }
        title={navLabel('/govern/workflow-defaults')}
      />
      <div className="grid gap-10 xl:grid-cols-[minmax(0,56rem)_200px]">
        <div className="min-w-0 space-y-6">
          <Section id="defaults">
            <WorkflowDefaultsForm />
          </Section>
          <Section id="consolidation">
            <ConsolidationForm />
          </Section>
          <Section id="revalidation">
            <RevalidationForm />
          </Section>
          <Section id="canary">
            <CanaryForm />
          </Section>
        </div>
        <nav aria-label="On this page" className="hidden xl:block">
          <div className="sticky top-6">
            <p className="kicker mb-3">On this page</p>
            <ul className="space-y-0.5 border-l border-ink-500">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a
                    className={`-ml-px block border-l border-transparent py-1.5 pl-3 hover:border-ember-400 ${FOCUS_RING}`}
                    href={`#${s.id}`}
                  >
                    <span className="block text-[13px] text-paper-200">{s.label}</span>
                    <span className="block text-xs text-paper-500">{s.hint}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </div>
    </div>
  );
}
