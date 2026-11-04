import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './Icon';

type StatTone = 'default' | 'muted' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<StatTone, string> = {
  danger: 'text-danger-400',
  default: 'text-paper-100',
  info: 'text-info-400',
  muted: 'text-paper-500',
  success: 'text-success-400',
  warning: 'text-warning-400',
};

/** Which way the figure moved. Independent of whether that is good news. */
export type StatDeltaDirection = 'up' | 'down' | 'flat';
/** Whether the move is good news, bad news, or neither (a volume that is simply what it is). */
export type StatDeltaTone = 'good' | 'bad' | 'neutral';

export interface StatDelta {
  /** The change as shown, e.g. `+12% vs previous 30 days`. */
  value: string;
  /** The arrow and the screen-reader word. When absent it is read from a leading sign in `value`. */
  direction?: StatDeltaDirection;
  /** The colour: `good` green, `bad` red, `neutral` calm grey. */
  tone?: StatDeltaTone;
  /**
   * @deprecated Conflates "is this good" with direction. Pass `direction` and `tone`. Read as
   * `tone: positive ? 'good' : 'bad'`; direction then comes from the sign of `value`, and only
   * when `value` carries no sign does it fall back to the old `positive` = up.
   */
  positive?: boolean;
}

/**
 * The direction a formatted change moved, read from its leading sign: `+` is up, `-` (hyphen
 * minus) and `−` (U+2212) and `–` (en dash) are down. `undefined` when it carries none.
 */
export function directionFromValue(value: string): StatDeltaDirection | undefined {
  const first = value.trimStart()[0];
  if (first === '+') {
    return 'up';
  }
  if (first === '-' || first === '−' || first === '–') {
    return 'down';
  }
  return undefined;
}

export function resolveDelta(delta: StatDelta): {
  direction: StatDeltaDirection;
  tone: StatDeltaTone;
} {
  const direction =
    delta.direction ??
    directionFromValue(delta.value) ??
    (delta.positive === false ? 'down' : 'up');
  const tone =
    delta.tone ?? (delta.positive === undefined ? 'neutral' : delta.positive ? 'good' : 'bad');
  return { direction, tone };
}

const DELTA_TONE: Record<StatDeltaTone, string> = {
  bad: 'text-danger-400',
  good: 'text-success-400',
  neutral: 'text-paper-400',
};

const DELTA_WORD: Record<StatDeltaDirection, string> = {
  down: 'Decrease',
  flat: 'No change',
  up: 'Increase',
};

const DELTA_TONE_WORD: Record<StatDeltaTone, string> = {
  bad: ', unfavourable',
  good: ', favourable',
  neutral: '',
};

export function Stat({
  label,
  value,
  unit,
  tone = 'default',
  delta,
  hint,
  icon,
  variant = 'rule',
  className,
}: {
  label: string;
  value: string | number;
  unit?: string;
  tone?: StatTone;
  /**
   * A change against a previous window. `direction` (arrow) and `tone` (colour) are separate:
   * spend up is an up arrow in red, errors down is a down arrow in green.
   */
  delta?: StatDelta | null;
  /** A quiet secondary line under the value (next run, a usage breakdown). */
  hint?: ReactNode;
  /** `tile` only: a leading icon beside the label. */
  icon?: IconName;
  /** `rule` (default): a left rule, no card. `tile`: a bordered card for a dashboard's top row. */
  variant?: 'rule' | 'tile';
  className?: string;
}) {
  const resolved = delta ? resolveDelta(delta) : null;
  return (
    <div
      className={cn(
        'min-w-0 break-words',
        variant === 'tile'
          ? 'rounded-xl border border-ink-400 bg-ink-700 p-4'
          : 'border-l-2 border-ink-500 py-1 pl-4',
        className
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-paper-400">
        {variant === 'tile' && icon && <Icon className="text-paper-500" name={icon} size={14} />}
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={cn('text-3xl leading-none font-semibold tracking-[-0.02em]', TONE[tone])}>
          {value}
        </span>
        {unit && <span className="text-sm text-paper-500">{unit}</span>}
      </div>
      {delta && resolved && (
        <div
          className={cn(
            'mt-2 inline-flex items-center gap-1 text-xs font-medium',
            DELTA_TONE[resolved.tone]
          )}
        >
          {resolved.direction === 'flat' ? (
            <span aria-hidden="true" className="w-3 text-center">
              –
            </span>
          ) : (
            <Icon
              name={resolved.direction === 'up' ? 'arrowUp' : 'arrowDown'}
              size={12}
              strokeWidth={2.2}
            />
          )}
          <span className="sr-only">{DELTA_WORD[resolved.direction]}</span>
          {delta.value}
          <span className="sr-only">{DELTA_TONE_WORD[resolved.tone]}</span>
        </div>
      )}
      {hint && <div className="mt-2 text-xs leading-relaxed text-paper-500">{hint}</div>}
    </div>
  );
}
