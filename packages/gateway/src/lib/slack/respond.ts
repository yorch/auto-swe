import { resolveSlackBotTokenForSlackChannel } from '@auto-swe/shared/lib/systemConfig';
import { postSlackMessage } from '../slack.js';
import type { SlackInteractivePayload } from './types.js';

/**
 * Best-effort reply to a Slack interaction. Success confirmations annotate the
 * original message as a thread reply (chat.postMessage — what lib/slack.ts
 * already supports); errors and the unlinked-account hint go to `response_url`
 * as an ephemeral message visible only to the clicker. Never replaces the
 * original message (`replace_original: false`) so the audit trail stays
 * intact. All failures are swallowed — Slack chatter must never fail the ack.
 */
export async function respondToInteraction(
  payload: SlackInteractivePayload,
  text: string,
  opts: { ephemeral: boolean }
): Promise<void> {
  try {
    if (!opts.ephemeral && payload.channel?.id && payload.message?.ts) {
      const botToken = await resolveSlackBotTokenForSlackChannel(payload.channel.id);
      const ts = await postSlackMessage(
        { channel: payload.channel.id, text, threadTs: payload.message.ts },
        botToken ?? undefined
      );
      if (ts) {
        return;
      }
      // fall through to response_url if the thread reply failed
    }
    if (payload.response_url) {
      await fetch(payload.response_url, {
        body: JSON.stringify({
          replace_original: false,
          response_type: opts.ephemeral ? 'ephemeral' : 'in_channel',
          text,
        }),
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        method: 'POST',
      });
    }
  } catch {
    /* best-effort */
  }
}
