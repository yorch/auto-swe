import { StartWork } from '@/components/requests/StartWork';

const MODES = ['workflow', 'agent', 'epic'] as const;

export default async function StartWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; template?: string }>;
}) {
  const { mode, template } = await searchParams;
  const initialMode = MODES.find((value) => value === mode) ?? (template ? 'workflow' : undefined);
  return <StartWork initialMode={initialMode} initialTemplateId={template?.slice(0, 64)} />;
}
