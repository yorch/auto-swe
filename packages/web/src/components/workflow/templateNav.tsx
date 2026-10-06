import Link from 'next/link';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { TabBar } from '@/components/ui/TabBar';
import { cn, FOCUS_RING } from '@/lib/utils';

/**
 * Shared chrome for the template detail page and its sub-pages (analytics,
 * run history, version diff): the back link, the sub-page tab bar, and the
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
  const base = `/workflows/library/${templateId}`;
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

/** Back link to the parent page, rendered above a page header. */
export function TemplateBackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm text-[13px] text-paper-400 transition-colors hover:text-paper-100',
        FOCUS_RING
      )}
      href={href}
    >
      <Icon name="arrowLeft" size={14} />
      {label}
    </Link>
  );
}

export function TemplateNotFound() {
  return (
    <EmptyState
      action={<ButtonLink href="/workflows/library">Back to library</ButtonLink>}
      bordered
      hint="It may have been deleted, or the link is wrong."
      icon="workflows"
      title="Workflow not found"
    />
  );
}
