import { ApplicationFailure } from '@temporalio/activity';

export interface SlackConnectionLike {
  apiToken: string;
}

const SLACK_TIMEOUT_MS = 30_000;

async function slackFetch<T>(
  connection: SlackConnectionLike,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `https://slack.com/api${path}`;
  const timeoutSignal = AbortSignal.timeout(SLACK_TIMEOUT_MS);
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.apiToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    const status = response.status;
    if (status === 401 || status === 403) {
      throw ApplicationFailure.nonRetryable(`Slack API authentication failed (${status})`);
    }
    if (status >= 500 || status === 429) {
      throw ApplicationFailure.create({
        message: `Slack API transient error (${status}): ${body}`,
        type: 'SlackTransientError',
      });
    }
    throw ApplicationFailure.nonRetryable(`Slack API error (${status}): ${body}`);
  }

  const data = (await response.json()) as { ok?: boolean; error?: string };
  if (data.ok === false) {
    if (data.error === 'channel_not_found' || data.error === 'not_in_channel') {
      throw ApplicationFailure.nonRetryable(`Slack API error: ${data.error}`);
    }
    if (data.error === 'rate_limited') {
      throw ApplicationFailure.create({
        message: `Slack API rate limited: ${data.error}`,
        type: 'SlackTransientError',
      });
    }
    throw ApplicationFailure.nonRetryable(`Slack API error: ${data.error ?? 'unknown'}`);
  }

  return data as T;
}

export interface SlackPostMessageInput {
  channelId: string;
  text: string;
}

export interface SlackPostMessageResult {
  channelId: string;
  ts: string;
}

export async function postSlackMessage(
  connection: SlackConnectionLike,
  input: SlackPostMessageInput
): Promise<SlackPostMessageResult> {
  const data = await slackFetch<{
    channel?: string;
    ok?: boolean;
    ts?: string;
  }>(connection, '/chat.postMessage', {
    body: JSON.stringify({ channel: input.channelId, text: input.text }),
    method: 'POST',
  });
  return { channelId: data.channel ?? input.channelId, ts: data.ts ?? '' };
}
