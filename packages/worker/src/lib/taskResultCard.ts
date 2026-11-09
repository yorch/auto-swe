/**
 * The Slack card for a channel task's final report. Fixed code wraps the result: a status line, the
 * result text, status/duration/cost fields and an Open run button. The result text itself is
 * model prose, and a card escapes its text wholesale, so Slack link syntax and any other markup in
 * it shows literally (bare URLs still link, since Slack links those itself). That flattening is the
 * price of a card that cannot broadcast, mention or disguise a link.
 *
 * Returns `null` when the spec is refused (an unparseable dashboard URL, say); the caller then
 * posts the plain text report it always has. Pure and I/O-free.
 */
import { clip, codeSafe, formatCost, formatDuration } from './runCompleteCard.js';
import { parseSlackCard, renderSlackCard } from './slackCard.js';

export type TaskResultStatus = 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED';

export interface TaskResultCardInput {
  status: TaskResultStatus;
  /** The task's title, when it has one. */
  title?: string | undefined;
  /** The agent's result text; only a successful task carries it. */
  resultText?: string | undefined;
  /** Why a failed task failed, when known. */
  reason?: string | undefined;
  costUsd?: number | null | undefined;
  startedAt?: Date | null | undefined;
  endedAt?: Date | null | undefined;
  /** The plain-text report; its first 300 characters become the notification fallback. */
  fallbackText: string;
  /** Absolute dashboard URL of the run; its host must equal `dashboardHost`. */
  runUrl: string;
  dashboardHost: string;
}

/** Below Slack's 3000-character section limit, with room for the characters escaping adds. */
const CHUNK_CHARS = 2400;
const MAX_TITLE_CHARS = 150;

/** Split prose into pieces of at most `max` characters, on paragraph, then line, then hard breaks. */
export function splitForSlack(text: string, max: number = CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) {
      pieces.push(current.trim());
    }
    current = '';
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    // A paragraph longer than the limit is cut on lines, then on the character count.
    const parts =
      paragraph.length <= max
        ? [paragraph]
        : paragraph
            .split('\n')
            .flatMap((line) =>
              line.length <= max
                ? [line]
                : (line.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) ?? [])
            );
    for (const part of parts) {
      const joiner = current ? (paragraph.length <= max ? '\n\n' : '\n') : '';
      if (current.length + joiner.length + part.length > max) {
        flush();
      }
      current += (current ? joiner : '') + part;
    }
  }
  flush();
  return pieces;
}

const STATUS_EMOJI: Record<TaskResultStatus, string> = {
  CANCELLED: ':octagonal_sign:',
  FAILED: ':rotating_light:',
  SKIPPED: ':rotating_light:',
  SUCCESS: ':white_check_mark:',
  TIMED_OUT: ':rotating_light:',
};

export function buildTaskResultCard(
  input: TaskResultCardInput
): { blocks: unknown[]; text: string } | null {
  const emoji = STATUS_EMOJI[input.status];
  const title = input.title ? codeSafe(clip(input.title, MAX_TITLE_CHARS)) : '';
  const titlePart = title ? ` *${title}*` : '';
  const headline =
    input.status === 'SUCCESS'
      ? `${emoji} Task${titlePart} is done`
      : `${emoji} Task${titlePart} finished with status *${input.status}*`;

  const body =
    input.status === 'SUCCESS'
      ? splitForSlack(input.resultText ?? '')
      : input.reason?.trim()
        ? splitForSlack(input.reason)
        : [];
  const duration = formatDuration(input.startedAt, input.endedAt);
  const cost = formatCost(input.costUsd);

  const parsed = parseSlackCard(
    {
      blocks: [
        { text: headline, type: 'text' },
        ...body.map((text) => ({ text, type: 'text' })),
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
      summary: clip(input.fallbackText.replace(/\s+/g, ' ').trim() || headline, 300),
    },
    { allowedLinkHosts: [input.dashboardHost] }
  );
  return parsed.ok ? renderSlackCard(parsed.card) : null;
}
