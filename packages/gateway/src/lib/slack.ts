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
    if (sigBuf.length !== expBuf.length) {
      return false;
    }
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
  token: string | undefined
): Promise<string | null> {
  if (!token) {
    return null;
  }
  const body: Record<string, unknown> = {
    channel: options.channel,
    text: options.text,
  };
  if (options.threadTs) {
    body.thread_ts = options.threadTs;
  }
  if (options.blocks) {
    body.blocks = options.blocks;
  }

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

interface SlackConversationsInfoResponse {
  ok: boolean;
  error?: string;
  channel?: { is_private?: boolean };
}

/**
 * Ask Slack whether a channel is private.
 *
 * `SlackChannel.isPrivate` decides whether a channel's memory can ever be read
 * by another channel, and the alternative is guessing from the shape of the
 * payload that provisioned it — `channel_type === 'group'` on the events path, a
 * `G`-prefixed id on the shortcut path. Neither is authoritative for every Slack
 * channel shape; `conversations.info` is.
 *
 * Returns `null` when Slack cannot answer — no token, a missing `groups:read`
 * scope, a network failure. The caller falls back to its heuristic rather than
 * guessing "public", so a deployment whose bot lacks the scope keeps working
 * exactly as it did.
 */
export async function fetchSlackChannelIsPrivate(
  slackChannelId: string,
  token: string | undefined
): Promise<boolean | null> {
  if (!token) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_POST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://slack.com/api/conversations.info?channel=${encodeURIComponent(slackChannelId)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }
    );
    const data = (await res.json()) as SlackConversationsInfoResponse;
    return data.ok && typeof data.channel?.is_private === 'boolean'
      ? data.channel.is_private
      : null;
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
 * Gap I (packaged Slack-app UX): build the App Home tab view (Block Kit). Pure
 * (no I/O) so it's directly unit-testable. The Home tab is the assistant's
 * "front door" — what it does and how to drive it — shown when a user opens the
 * app in Slack. Static content (no per-user DB read), so it can't fail.
 */
export function buildAppHomeView(): {
  type: 'home';
  blocks: unknown[];
} {
  return {
    blocks: [
      {
        text: {
          emoji: true,
          text: ':robot_face: auto-swe — your channel teammate',
          type: 'plain_text',
        },
        type: 'header',
      },
      {
        text: {
          text: "I'm a shared assistant that lives in your Slack channels. Add me to a channel, then *@mention* me to ask a question or hand off real work — I keep per-channel memory, can run multi-step tasks end to end, and (when enabled) chime in proactively.",
          type: 'mrkdwn',
        },
        type: 'section',
      },
      { type: 'divider' },
      {
        text: { text: '*How to work with me*', type: 'mrkdwn' },
        type: 'section',
      },
      {
        text: {
          text: "• *@mention me in a channel* — ask a question, or delegate a task (I'll work it and report back in the thread).\n• *Reply in a task's thread* — steer a run while it's in flight; anyone on the channel can jump in.\n• *Follow-up replies* — when a channel enables follow-up sessions, you can keep the conversation going without re-@mentioning me.\n• *DM me* — for anything you'd rather keep private.",
          type: 'mrkdwn',
        },
        type: 'section',
      },
      { type: 'divider' },
      {
        text: { text: '*Slash commands*', type: 'mrkdwn' },
        type: 'section',
      },
      {
        text: {
          text: '• `/auto-swe help` — show what I can do\n• `/auto-swe workflows list` — list available workflows\n• `/auto-swe run` — start a workflow from a picker',
          type: 'mrkdwn',
        },
        type: 'section',
      },
      {
        elements: [
          {
            text: 'Admins configure channels, budgets, memory, and proactivity in the auto-swe dashboard.',
            type: 'mrkdwn',
          },
        ],
        type: 'context',
      },
    ],
    type: 'home',
  };
}

/**
 * Shared one-shot POST to a Slack Web API method (JSON body, bot-token auth).
 * Centralises the token guard + headers + `res.json()` + ok/error shaping that
 * `publishAppHome` and `openSlackView` otherwise each hand-rolled. Returns the
 * parsed body on success so callers can read method-specific fields (e.g.
 * `views.open`'s `view.id`). Never throws — a network error is shaped to
 * `{ ok: false, error }`. (`postSlackMessage` keeps its own timeout-bounded
 * variant.)
 */
async function slackApiPost<T extends { ok: boolean; error?: string }>(
  method: string,
  payload: unknown,
  token: string | undefined
): Promise<{ ok: boolean; error?: string; data?: T }> {
  if (!token) {
    return { error: 'Slack bot token not configured', ok: false };
  }
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      body: JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      method: 'POST',
    });
    const data = (await res.json()) as T;
    return data.ok ? { data, ok: true } : { error: data.error ?? 'unknown', ok: false };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ok: false };
  }
}

/**
 * Gap I: publish the App Home view for a user via `views.publish`. Best-effort —
 * returns `{ok:false}` on any failure (a Home-tab publish must never throw into
 * the events handler).
 */
export async function publishAppHome(
  userId: string,
  token: string | undefined
): Promise<{ ok: boolean; error?: string }> {
  const res = await slackApiPost(
    'views.publish',
    { user_id: userId, view: buildAppHomeView() },
    token
  );
  return { error: res.error, ok: res.ok };
}

/**
 * Open a Slack modal via `views.open`. Used by the work-request slash command
 * to show a workflow + repo picker.
 */
export async function openSlackView(
  options: SlackViewsOpenOptions,
  token: string | undefined
): Promise<{ ok: boolean; viewId?: string; error?: string }> {
  if (!token) {
    // Keep the bespoke, user-facing hint (surfaced in the slash-command ephemeral).
    return { error: 'Slack bot token not configured — set it at /admin/integrations', ok: false };
  }
  const res = await slackApiPost<SlackViewsOpenResponse>(
    'views.open',
    { trigger_id: options.triggerId, view: options.view },
    token
  );
  if (!res.ok) {
    return { error: res.error, ok: false };
  }
  return { ok: true, ...(res.data?.view?.id ? { viewId: res.data.view.id } : {}) };
}
