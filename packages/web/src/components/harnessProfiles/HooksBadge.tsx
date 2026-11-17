import { Badge } from '@/components/ui/Badge';

/** A plugin's hook switch as a badge; hooks on is the state worth noticing. */
export function HooksBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge dot tone={enabled ? 'warning' : 'neutral'}>
      {enabled ? 'Hooks on' : 'Hooks off'}
    </Badge>
  );
}
