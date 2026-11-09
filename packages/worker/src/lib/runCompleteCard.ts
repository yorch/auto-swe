/**
 * The Slack card for a finished run. Built entirely by fixed code from the run's own row, with no
 * model involved, and passed through the same validator the assistant's cards use, so the escaping
 * and the link-host policy apply here too. Pure and I/O-free.
 *
 * Returns `null` when the spec is refused (an unparseable dashboard URL, say). The caller then
 * posts the plain one-line notification it always has: a card is an upgrade, never a reason to
 * lose the notification.
 */
import { parseSlackCard, renderSlackCard } from './slackCard.js';

export type RunCompleteStatus = 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED';

export interface RunCompleteCardInput {
  ticket: string;
  templateName: string;
  status: RunCompleteStatus;
  startedAt?: Date | null;
  endedAt?: Date | null;
  costUsd?: number | null;
  /** Absolute dashboard URL of the run; its host must equal `dashboardHost`. */
  runUrl: string;
  /** `host[:port]` of the dashboard, the only host the button may link to. */
  dashboardHost: string;
}

const STATUS_EMOJI: Record<RunCompleteStatus, string> = {
  CANCELLED: ':octagonal_sign:',
  FAILED: ':rotating_light:',
  SKIPPED: ':rotating_light:',
  SUCCESS: ':white_check_mark:',
  TIMED_OUT: ':rotating_light:',
};

/** Ticket ids and template names are user-chosen; keep either from flooding the card. */
const MAX_LABEL_CHARS = 120;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A name safe to put between backticks: no backtick can end the code span early. */
function codeSafe(text: string): string {
  return clip(text.replace(/`/g, "'").replace(/\s+/g, ' ').trim(), MAX_LABEL_CHARS);
}

/** `45s`, `3m 12s`, `1h 5m`; `null` when either end is missing or the span is negative. */
export function formatDuration(startedAt?: Date | null, endedAt?: Date | null): string | null {
  if (!startedAt || !endedAt) {
    return null;
  }
  const ms = endedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 1) {
    return '<1s';
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** `$0.42`; `<$0.01` for a real but tiny spend; `null` for nothing worth showing. */
export function formatCost(costUsd?: number | null): string | null {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd <= 0) {
    return null;
  }
  return costUsd < 0.01 ? '<$0.01' : `$${costUsd.toFixed(2)}`;
}

export function buildRunCompleteCard(
  input: RunCompleteCardInput
): { blocks: unknown[]; text: string } | null {
  const ticket = codeSafe(input.ticket);
  const template = codeSafe(input.templateName);
  const emoji = STATUS_EMOJI[input.status];
  const duration = formatDuration(input.startedAt, input.endedAt);
  const cost = formatCost(input.costUsd);

  const parsed = parseSlackCard(
    {
      blocks: [
        { text: `${emoji} *[${ticket}]* \`${template}\` run finished`, type: 'text' },
        {
          items: [
            { label: 'Status', value: input.status },
            ...(duration ? [{ label: 'Duration', value: duration }] : []),
            ...(cost ? [{ label: 'Cost', value: cost }] : []),
          ],
          type: 'fields',
        },
        { items: [{ label: 'Open run', url: input.runUrl }], type: 'buttons' },
      ],
      summary: clip(`${emoji} [${ticket}] ${template} run finished: ${input.status}`, 300),
    },
    { allowedLinkHosts: [input.dashboardHost] }
  );
  return parsed.ok ? renderSlackCard(parsed.card) : null;
}
