import type { CampaignStateValue, TargetState } from '@auto-swe/shared/lib/campaignState';
import { cn } from '@/lib/utils';
import {
  CAMPAIGN_STATE_TONES,
  campaignStateLabel,
  type StateTone,
  targetStateLabel,
  targetStateTone,
} from './campaignDisplay';

const DOT: Record<StateTone, string> = {
  accent: 'bg-accent2-400',
  danger: 'bg-danger-400',
  info: 'bg-info-400',
  live: 'bg-info-400 pulse-dot',
  neutral: 'bg-paper-600',
  success: 'bg-success-400',
  warning: 'bg-warning-400',
};

/** A coloured dot and the state's name; the name carries the meaning, never the colour alone. */
function StateBadge({ label, tone }: { label: string; tone: StateTone }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-paper-300">
      <span aria-hidden className={cn('inline-block h-2 w-2 shrink-0 rounded-full', DOT[tone])} />
      {label}
    </span>
  );
}

/** A campaign's state, including the legacy values old campaigns still carry. */
export function CampaignStateBadge({ state }: { state: CampaignStateValue }) {
  return (
    <StateBadge label={campaignStateLabel(state)} tone={CAMPAIGN_STATE_TONES[state] ?? 'neutral'} />
  );
}

/** A target's state; a retired value shows as the state that replaced it. */
export function TargetStateBadge({ state }: { state: TargetState }) {
  return <StateBadge label={targetStateLabel(state)} tone={targetStateTone(state)} />;
}
