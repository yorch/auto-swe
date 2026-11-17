import { escapeSlackMrkdwn } from './hitlSlackSync.js';

/** A step may be nudged at most once per this long. */
export const NUDGE_INTERVAL_MS = 4 * 60 * 60 * 1000;

const TITLE_MAX_CHARS = 200;

/** Where the worker recorded the Slack message that announced a human step. */
export interface NudgeSlackMessage {
  channel: string;
  ts: string;
}

/** The recorded announcement's channel and timestamp, or null when none (or a malformed one) is stored. */
export function nudgeSlackMessage(json: unknown): NudgeSlackMessage | null {
  if (json === null || typeof json !== 'object') {
    return null;
  }
  const { channel, ts } = json as Record<string, unknown>;
  return typeof channel === 'string' && channel && typeof ts === 'string' && ts
    ? { channel, ts }
    : null;
}

/**
 * The fixed reminder text. Only the step title is variable, and it is escaped, so the text can
 * never carry a `<!channel>`, `<!here>` or `<!everyone>` broadcast.
 */
export function nudgeText(title: string, requestedAt: Date): string {
  const clipped =
    title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1)}…` : title;
  return `Reminder: "${escapeSlackMrkdwn(clipped)}" has been waiting for an answer since ${requestedAt.toISOString().slice(0, 10)}.`;
}
