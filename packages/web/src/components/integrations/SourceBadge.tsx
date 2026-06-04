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
    <span
      className="inline-flex items-center rounded-sm bg-amber-900/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-amber-400"
      title="Value comes from an environment variable. Saving here will override it."
    >
      env
    </span>
  );
}
