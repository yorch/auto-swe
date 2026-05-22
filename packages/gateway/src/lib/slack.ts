import crypto from 'node:crypto';

/**
 * Shared Slack helpers used by:
 *   - `routes/slack.ts` (interactive webhook + OAuth + slash command)
 *   - any future activity that needs to post into Slack from the gateway
 *
 * The signature verification + replay window are extracted here so both the
 * interactive endpoint and the slash-command endpoint share one implementation.
 */

export const SLACK_TIMESTAMP_MAX_AGE = 5 * 60; // 5 minutes (Slack-recommended replay window)

/**
 * Verify a Slack request signature using the signing secret.
 *
 * Returns false on any of: stale timestamp, malformed signature, hash mismatch.
 * Caller is responsible for short-circuiting with 401 on false.
 */
export function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
  now: number = Math.floor(Date.now() / 1000)
): boolean {
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SLACK_TIMESTAMP_MAX_AGE) {
    return false;
  }

  const baseString = `v0:${timestamp}:${body}`;
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex')}`;

  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

interface SlackPostMessageOptions {
  channel: string;
  text: string;
  threadTs?: string;
  blocks?: unknown[];
}

interface SlackChatPostMessageResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

/**
 * Best-effort `chat.postMessage`. The caller decides whether failures should
 * surface (they typically shouldn't — Slack downtime must not break workflow
 * step recording). Returns the message timestamp on success, null on failure.
 *
 * No-ops (and returns null) when `SLACK_BOT_TOKEN` is not set. This lets the
 * notification path stay enabled without configuration.
 */
const SLACK_POST_TIMEOUT_MS = 2_000;

export async function postSlackMessage(
  options: SlackPostMessageOptions,
  token: string | undefined = process.env.SLACK_BOT_TOKEN
): Promise<string | null> {
  if (!token) return null;
  const body: Record<string, unknown> = {
    channel: options.channel,
    text: options.text,
  };
  if (options.threadTs) body.thread_ts = options.threadTs;
  if (options.blocks) body.blocks = options.blocks;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_POST_TIMEOUT_MS);
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      method: 'POST',
      signal: controller.signal,
    });
    const data = (await res.json()) as SlackChatPostMessageResponse;
    return data.ok && data.ts ? data.ts : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface SlackViewsOpenOptions {
  triggerId: string;
  view: unknown;
}

interface SlackViewsOpenResponse {
  ok: boolean;
  error?: string;
  view?: { id: string };
}

/**
 * Open a Slack modal via `views.open`. Used by the work-request slash command
 * to show a workflow + repo picker.
 */
export async function openSlackView(
  options: SlackViewsOpenOptions,
  token: string | undefined = process.env.SLACK_BOT_TOKEN
): Promise<{ ok: boolean; viewId?: string; error?: string }> {
  if (!token) return { error: 'SLACK_BOT_TOKEN not configured', ok: false };
  try {
    const res = await fetch('https://slack.com/api/views.open', {
      body: JSON.stringify({ trigger_id: options.triggerId, view: options.view }),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      method: 'POST',
    });
    const data = (await res.json()) as SlackViewsOpenResponse;
    return data.ok
      ? { ok: true, ...(data.view?.id ? { viewId: data.view.id } : {}) }
      : { error: data.error ?? 'unknown', ok: false };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ok: false };
  }
}
