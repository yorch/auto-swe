import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { TabBar } from '@/components/ui/TabBar';

/**
 * Shared chrome for the template detail page and its sub-pages (analytics,
 * run history, version diff): the sub-page tab bar and the
 * not-found state. Each sub-page is its own route, so the tabs are links.
 */

export type TemplateSubTab = 'editor' | 'analytics' | 'runs' | 'compare';

export function TemplateSubNav({
  active,
  templateId,
}: {
  active: TemplateSubTab;
  templateId: string;
}) {
  const base = `/library/${templateId}`;
  return (
    <TabBar
      active={active}
      tabs={[
        { href: base, id: 'editor', label: 'Editor' },
        { href: `${base}/analytics`, id: 'analytics', label: 'Analytics' },
        { href: `${base}/runs`, id: 'runs', label: 'Run history' },
        { href: `${base}/diff`, id: 'compare', label: 'Compare versions' },
      ]}
    />
  );
}

export function TemplateNotFound() {
  return (
    <EmptyState
      action={<ButtonLink href="/library">Back to library</ButtonLink>}
      bordered
      hint="It may have been deleted, or the link is wrong."
      icon="workflows"
      title="Workflow not found"
    />
  );
}
