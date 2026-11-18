import { StartWork } from '@/components/requests/StartWork';

const MODES = ['workflow', 'agent', 'orchestrate', 'epic', 'prd', 'plan'] as const;

/** The ids `POST /run-plans` mints for a generation job. */
const JOB_ID_RE = /^runplan-[0-9a-f]{8}-[0-9a-f]{16,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StartWorkPage({
  searchParams,
}: {
  searchParams: Promise<{
    mode?: string;
    team?: string;
    template?: string;
    job?: string;
    plan?: string;
  }>;
}) {
  const { job, mode, plan, team, template } = await searchParams;
  // A valid job or plan id opens the plan flow whatever `mode` says; anything else is ignored and
  // the normal form shows.
  const initialJobId = job && JOB_ID_RE.test(job) ? job : undefined;
  const initialPlanId = plan && UUID_RE.test(plan) ? plan : undefined;
  const initialMode =
    initialJobId || initialPlanId
      ? 'plan'
      : (MODES.find((value) => value === mode) ?? (template ? 'workflow' : undefined));
  const initialTemplateId = template?.slice(0, 64);
  const initialTeamSlug = team?.slice(0, 50);
  // Keyed so a sidebar "Start work" click from /start?mode=agent re-seeds the mode
  // instead of keeping the state the already-mounted page was initialised with.
  return (
    <StartWork
      initialJobId={initialJobId}
      initialMode={initialMode}
      initialPlanId={initialPlanId}
      initialTeamSlug={initialTeamSlug}
      initialTemplateId={initialTemplateId}
      key={`${initialMode ?? ''}:${initialTemplateId ?? ''}:${initialTeamSlug ?? ''}:${initialJobId ?? ''}:${initialPlanId ?? ''}`}
    />
  );
}
