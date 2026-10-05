import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';

/**
 * The line under a secret input: where the value comes from, and one optional action to remove or
 * restore it. Presentational only — the integration forms clear a stored value immediately, the
 * MCP form stages the clear until save, and both render the row the same way.
 */
export function SecretStatusRow({
  action,
  children,
}: {
  action?: {
    ariaLabel?: string;
    label: string;
    onClick: () => void;
    /** Set when the action toggles a staged change. */
    pressed?: boolean;
  };
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-paper-400">
      <span>{children}</span>
      {action && (
        <Button
          aria-label={action.ariaLabel}
          aria-pressed={action.pressed}
          onClick={action.onClick}
          size="sm"
          type="button"
          variant="ghost"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
