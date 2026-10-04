import { StartWork } from '@/components/requests/StartWork';

const MODES = ['workflow', 'agent', 'epic'] as const;

export default async function StartWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; template?: string }>;
}) {
  const { mode, template } = await searchParams;
  const initialMode = MODES.find((value) => value === mode) ?? (template ? 'workflow' : undefined);
  const initialTemplateId = template?.slice(0, 64);
  // Keyed so a sidebar "Start work" click from /start?mode=agent re-seeds the mode
  // instead of keeping the state the already-mounted page was initialised with.
  return (
    <StartWork
      initialMode={initialMode}
      initialTemplateId={initialTemplateId}
      key={`${initialMode ?? ''}:${initialTemplateId ?? ''}`}
    />
  );
}
