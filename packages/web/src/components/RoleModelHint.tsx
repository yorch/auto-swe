import { cn } from '@/lib/utils';

/**
 * The one short explanation of how standing works, shown wherever a person is told which role
 * they hold: three independent levels, and authority at a higher one does not bring a role at a
 * lower one.
 */
export function RoleModelHint({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs text-paper-400', className)} data-testid="role-model-hint">
      Access has three levels. Your platform role covers the whole deployment, your organization
      role covers that organization&apos;s teams, budgets and repositories, and your team role
      covers the work inside one team. A role at one level does not give you a role at another: an
      organization admin is not a member of its teams until added.
    </p>
  );
}
