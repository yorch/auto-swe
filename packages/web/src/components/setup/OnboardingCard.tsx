'use client';

import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';

/**
 * The one card Home uses for onboarding, whichever checklist applies: an admin's setup steps
 * (`SetupReadiness`) or a member's first-run steps (`FirstRunChecklist`), which are mutually
 * exclusive by role. The body can be folded away so a half-finished checklist does not
 * push the person's own work off the screen; the fold is per page view and persists nothing.
 */
export function OnboardingCard({
  actions,
  children,
  className,
  status,
  subtitle,
  testId,
  title,
}: {
  /** Extra header controls, shown beside the status and the fold button. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  status?: ReactNode;
  subtitle?: ReactNode;
  testId?: string;
  title: string;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <Card className={className} data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-paper-50">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-paper-400">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-3">
          {status}
          {actions}
          <Button
            aria-controls={bodyId}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
            onClick={() => setOpen((value) => !value)}
            size="sm"
            variant="ghost"
          >
            <Icon className={cn(!open && '-rotate-90')} name="chevronDown" size={14} />
          </Button>
        </div>
      </div>
      <div hidden={!open} id={bodyId}>
        {children}
      </div>
    </Card>
  );
}
