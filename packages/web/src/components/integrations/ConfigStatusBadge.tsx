import { Badge } from '@/components/ui/Badge';
import type { ConfigSource } from '@/hooks/useAdminConfig';

/** Where a group of settings stands: saved here, read from the environment, half done, or empty. */
export type ConfigState = 'configured' | 'env' | 'partial' | 'unset';

/** One field's state: an environment fallback wins the label, since it is what the platform reads. */
export function fieldState(value: unknown, source?: ConfigSource): ConfigState {
  if (source === 'env') {
    return 'env';
  }
  const set = value !== undefined && value !== null && value !== '' && value !== false;
  return set ? 'configured' : 'unset';
}

/**
 * A card's state from the fields it needs. Every field set reads as configured (or "From env"
 * when any of them comes from the environment), none as not set, anything between as partial.
 */
export function groupState(states: ConfigState[]): ConfigState {
  const set = states.filter((s) => s !== 'unset');
  if (set.length === 0) {
    return 'unset';
  }
  if (set.length < states.length) {
    return 'partial';
  }
  return set.includes('env') ? 'env' : 'configured';
}

const LABEL: Record<ConfigState, string> = {
  configured: 'Configured',
  env: 'From env',
  partial: 'Partly set',
  unset: 'Not set',
};

const TONE = { configured: 'moss', env: 'amber', partial: 'amber', unset: 'muted' } as const;

/** The status pill in an integration card's header. */
export function ConfigStatusBadge({ state, title }: { state: ConfigState; title?: string }) {
  return (
    <Badge dot title={title} tone={TONE[state]} variant="outline">
      {LABEL[state]}
    </Badge>
  );
}
