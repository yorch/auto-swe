import { Badge } from '@/components/ui/Badge';
import type { ConfigSource } from '@/hooks/useAdminConfig';

interface SourceBadgeProps {
  source: ConfigSource | undefined;
}

/// Shows a small "env" badge when a config value is coming from an environment
/// variable rather than the database. No badge is rendered for db-sourced or
/// absent values.
export function SourceBadge({ source }: SourceBadgeProps) {
  if (source !== 'env') {
    return null;
  }
  return (
    <Badge
      className="rounded-sm text-[9px] tracking-widest"
      title="Value comes from an environment variable. Saving here will override it."
      tone="amber"
      uppercase
    >
      env
    </Badge>
  );
}
