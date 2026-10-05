import type { PrismaClient } from '@auto-swe/shared';
import { resolveSlackBotTokenForSlackChannel } from '@auto-swe/shared/lib/systemConfig';

/**
 * Edits the Slack message that announced a human step so it shows how the step was decided,
 * whether the answer came from the web inbox or a Slack button. The message location is
 * recorded by the worker in `WorkflowHumanStep.slackMessage` when it posts the announcement.
 *
 * Best-effort by contract: Slack being down, the bot lacking a scope, or the message being gone
 * must never fail the response that was already recorded, so this never throws.
 */

const SLACK_UPDATE_URL = 'https://slack.com/api/chat.update';
const SLACK_UPDATE_TIMEOUT_MS = 2_000;
const COMMENT_MAX_CHARS = 500;

/** Escapes the three characters Slack mrkdwn treats as control (`&`, `<`, `>`). */
export function escapeSlackMrkdwn(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export interface HitlSlackOutcome {
  action: string;
  /** The chosen option for a decision step. */
  value?: unknown;
  /** The approver's note, as typed. Escaped here. */
  comment?: string | undefined;
  /** Platform user who answered. */
  userId: string;
}

interface StoredSlackMessage {
  channel: string;
  text: string;
  ts: string;
}

function parseSlackMessage(json: unknown): StoredSlackMessage | null {
  if (json === null || typeof json !== 'object') {
    return null;
  }
  const { channel, text, ts } = json as Record<string, unknown>;
  return typeof channel === 'string' && typeof ts === 'string' && typeof text === 'string'
    ? { channel, text, ts }
    : null;
}

/** One approver of a multi-approver step, with the note they left, if any. */
export interface HitlSlackApprover {
  comment?: string | undefined;
  name: string;
}

function quote(text: string): string {
  const note = text.trim();
  const clipped =
    note.length > COMMENT_MAX_CHARS ? `${note.slice(0, COMMENT_MAX_CHARS - 1)}…` : note;
  return escapeSlackMrkdwn(clipped).replaceAll(/\r?\n/g, '\n> ');
}

/**
 * The decision line shown on the message, e.g. `:white_check_mark: *Approved* by Dana`. A step that
 * needed several approvals passes `approvers`, so the line names all of them and each note is
 * attributed rather than showing only the last approver's.
 */
export function buildOutcomeText(
  header: string,
  outcome: HitlSlackOutcome,
  who: string,
  approvers: readonly HitlSlackApprover[] = []
): string {
  if (outcome.action === 'approve' && approvers.length > 1) {
    const names = approvers.map((a) => escapeSlackMrkdwn(a.name)).join(', ');
    const notes = approvers
      .filter((a) => a.comment?.trim())
      .map((a) => `> *${escapeSlackMrkdwn(a.name)}:* ${quote(a.comment as string)}`);
    return [header, `:white_check_mark: *Approved* by ${names}`, ...notes].join('\n');
  }
  const person = escapeSlackMrkdwn(who);
  let line: string;
  if (outcome.action === 'approve') {
    line = `:white_check_mark: *Approved* by ${person}`;
  } else if (outcome.action === 'reject') {
    line = `:x: *Rejected* by ${person}`;
  } else if (typeof outcome.value === 'string' && outcome.value) {
    line = `:white_check_mark: *Decided* by ${person}: ${escapeSlackMrkdwn(outcome.value)}`;
  } else {
    line = `:white_check_mark: *Answered* by ${person}`;
  }
  const note = outcome.comment?.trim();
  if (!note) {
    return `${header}\n${line}`;
  }
  return `${header}\n${line}\n> ${quote(note)}`;
}

/** Everyone who approved the step, oldest first, with the note stored on their approval. */
async function loadApprovers(
  prisma: PrismaClient,
  stepId: string,
  action: string
): Promise<HitlSlackApprover[]> {
  if (action !== 'approve') {
    return [];
  }
  const rows = await prisma.humanApproval.findMany({
    orderBy: { resolvedAt: 'asc' },
    select: { resolvedByUser: { select: { email: true, name: true } }, value: true },
    where: { action: 'approve', stepId },
  });
  return rows.map((row) => {
    const comment = (row.value as { comment?: unknown } | null)?.comment;
    return {
      comment: typeof comment === 'string' ? comment : undefined,
      name: row.resolvedByUser?.name ?? row.resolvedByUser?.email ?? 'Someone',
    };
  });
}

export async function syncSlackHumanStepOutcome(
  deps: {
    prisma: PrismaClient;
    log: { warn(obj: unknown, msg?: string): void };
  },
  stepId: string,
  outcome: HitlSlackOutcome
): Promise<void> {
  try {
    const step = await deps.prisma.workflowHumanStep.findUnique({
      select: { slackMessage: true },
      where: { id: stepId },
    });
    const message = parseSlackMessage(step?.slackMessage);
    if (!message) {
      return;
    }
    const token = await resolveSlackBotTokenForSlackChannel(message.channel);
    if (!token) {
      return;
    }
    const user = await deps.prisma.user.findUnique({
      select: { email: true, name: true },
      where: { id: outcome.userId },
    });
    const approvers = await loadApprovers(deps.prisma, stepId, outcome.action);
    const text = buildOutcomeText(
      message.text,
      outcome,
      user?.name ?? user?.email ?? 'Someone',
      approvers
    );
    const res = await fetch(SLACK_UPDATE_URL, {
      body: JSON.stringify({
        // Replacing the blocks drops the buttons, so a decided step cannot be answered twice.
        blocks: [{ text: { text, type: 'mrkdwn' }, type: 'section' }],
        channel: message.channel,
        text,
        ts: message.ts,
      }),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      method: 'POST',
      signal: AbortSignal.timeout(SLACK_UPDATE_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!data.ok) {
      deps.log.warn({ error: data.error, stepId }, 'Slack human-step message update refused');
    }
  } catch (err) {
    deps.log.warn({ err, stepId }, 'Slack human-step message update failed');
  }
}
