import type { ReactNode } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';

/**
 * One group of integration settings: a titled card with an optional status pill
 * in its header, a short explanation, the fields, and an optional footer row
 * (a "Test connection" button and its result). Every integration tab builds its
 * cards from this, so the tabs read the same.
 */
export function IntegrationCard({
  children,
  description,
  eyebrow,
  footer,
  headerAction,
  status,
  title,
}: {
  children?: ReactNode;
  description?: ReactNode;
  eyebrow?: string;
  /** Actions under a divider at the bottom of the card. */
  footer?: ReactNode;
  /** A control beside the status pill, such as "Add host". */
  headerAction?: ReactNode;
  /** A `ConfigStatusBadge`, shown at the right of the header. */
  status?: ReactNode;
  title: ReactNode;
}) {
  return (
    <Card className="p-5 sm:p-6">
      <CardHeader className="items-start">
        <CardTitle eyebrow={eyebrow}>{title}</CardTitle>
        {(status || headerAction) && (
          <div className="flex flex-wrap items-center gap-2">
            {status}
            {headerAction}
          </div>
        )}
      </CardHeader>
      {description && (
        <div className="-mt-1 mb-5 max-w-3xl text-[13px] leading-relaxed text-paper-400">
          {description}
        </div>
      )}
      {children}
      {footer && <div className="mt-5 border-t border-ink-600 pt-4">{footer}</div>}
    </Card>
  );
}

/** Two columns of fields from `sm` up; a field that needs the full width takes `sm:col-span-2`. */
export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">{children}</div>;
}
