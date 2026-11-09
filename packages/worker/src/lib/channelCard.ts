import { approvedRepositoryHosts } from '@auto-swe/shared/lib/connectionCredential';
import { resolveWebUrl } from '@auto-swe/shared/lib/systemConfig';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { parseSlackCard, renderSlackCard } from './slackCard.js';

/**
 * A rendered Slack card the agent asked to post as its reply. Plain JSON on purpose: the workflow
 * runs in a V8 isolate and cannot import the validator, so it receives `blocks` ready to send.
 */
export interface ChannelCard {
  blocks: unknown[];
  /** Plain-text fallback for notifications and clients that do not render blocks. */
  text: string;
}

/** Output the agent sees back from `postCard`: either accepted, or the problems to fix. */
const PostCardOutputSchema = z.object({
  issues: z.array(z.string()).optional(),
  note: z.string(),
  posted: z.boolean(),
});

/**
 * Build the `postCard` Mastra tool. Calling it VALIDATES the spec on the spot: a refusal comes back
 * to the model as the tool result (every problem listed), so it can correct and call again within
 * the same turn. An accepted card is RECORDED into `onCard` and rendered to Block Kit after the
 * turn; nothing is posted from here. A later accepted call replaces an earlier one.
 *
 * `allowedLinkHosts` limits where a button may point: a channel is a lower-trust input, and a
 * prompt-injected message must not be able to put an arbitrary link on a button.
 */
export function buildPostCardTool(
  allowedLinkHosts: readonly string[],
  onCard: (card: ChannelCard) => void
) {
  return createTool({
    description:
      'Reply with a structured Slack card (header, text, fields, table, buttons) instead of ' +
      'plain text. The spec is validated; if it is refused the problems are returned so you can fix it.',
    execute: async ({ spec }) => {
      const parsed = parseSlackCard(spec, { allowedLinkHosts });
      if (!parsed.ok) {
        return {
          issues: parsed.issues.slice(0, MAX_CARD_ISSUES_REPORTED),
          note: 'Card refused. Fix the listed problems and call postCard again.',
          posted: false,
        };
      }
      onCard(renderSlackCard(parsed.card));
      return { note: 'Card accepted — it will be posted as your reply.', posted: true };
    },
    id: 'postCard',
    inputSchema: z.object({
      spec: z
        .unknown()
        .describe('The card: { summary?, blocks: Component[] } as described in your instructions.'),
    }),
    outputSchema: PostCardOutputSchema,
  });
}

/** Cap on how many validation problems go back to the model in one tool result. */
const MAX_CARD_ISSUES_REPORTED = 10;

/**
 * Hosts a card button may link to: the dashboard and the approved repository hosts. A failure
 * resolving the repository hosts degrades to the dashboard alone, never to "any host".
 */
export async function resolveCardLinkHosts(): Promise<string[]> {
  const hosts: string[] = [];
  try {
    hosts.push(new URL(resolveWebUrl()).host.toLowerCase());
  } catch {
    // An unparseable WEB_URL contributes nothing; links then have no allowed host.
  }
  try {
    hosts.push(...(await approvedRepositoryHosts()).map((h) => h.toLowerCase()));
  } catch {
    // Settings unreadable: keep the dashboard host only.
  }
  return [...new Set(hosts)];
}
