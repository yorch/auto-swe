'use client';

import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import type { IconName } from '@/components/ui/Icon';

/**
 * A team-space tab whose content is an existing page: the tab is a short panel and one link
 * to that page, which reads `?team=<slug>` and narrows itself to the team.
 */
export function TeamLinkPanel({
  href,
  hint,
  icon,
  linkLabel,
  slug,
  title,
}: {
  /** The existing page's path, without the query. */
  href: string;
  hint: string;
  icon: IconName;
  linkLabel: string;
  slug: string;
  title: string;
}) {
  return (
    <Card>
      <EmptyState
        action={
          <ButtonLink href={`${href}?team=${encodeURIComponent(slug)}`} variant="primary">
            {linkLabel}
          </ButtonLink>
        }
        hint={hint}
        icon={icon}
        title={title}
      />
    </Card>
  );
}
