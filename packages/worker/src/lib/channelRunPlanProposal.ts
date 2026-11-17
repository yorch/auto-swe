import {
  SLACK_ACTION_VALUE_MAX,
  SLACK_RUN_PLAN_ACTION_ID,
} from '@auto-swe/shared/lib/slackRunPlanToken';
import { escapeSlackText } from './slackEscape.js';

/**
 * The Slack message that offers to turn a request into a plan, built by fixed code.
 *
 * The goal is the text of the message the person wrote, quoted back escaped; it is never a model's
 * paraphrase. The only thing a model contributes to the proposal is a mode, an agent key and a
 * repository hint, and all three are checked against what the person and the channel may use.
 */

/** A section's text may not pass 3000 characters in Slack; stay well under it. */
export const PROPOSAL_QUOTE_MAX_CHARS = 2400;

/**
 * The goal: the invoking person's own message text, trimmed, with any `<@U…>` mention token
 * removed. The gateway already strips the bot mention and collapses whitespace; this repeats the
 * strip so the rule holds for any caller. Never a model's output.
 */
export function goalFromSlackMessage(userText: string): string {
  return userText.replace(/<@[A-Z0-9]+(\|[^>]*)?>/gi, ' ').trim();
}

/** Quote text as a Slack block quote, escaped so it cannot carry markup, a link or a mention. */
export function quoteForSlack(text: string): string {
  return escapeSlackText(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export interface ProposalMessage {
  text: string;
  blocks?: unknown[];
}

/** A proposal that carries no button: an explanation of why none is offered. */
export function explain(text: string): ProposalMessage {
  return { text };
}

export interface ProposalFacts {
  goal: string;
  repoLabel: string;
  mode: 'delivering' | 'output-only';
  agentKey: string | null;
  token: string;
}

/**
 * The confirmation with its button, or `null` when it would not fit Slack's limits (a button
 * `value` of 2000 characters, a section of 3000). A `null` is reported to the person, never
 * trimmed: what is quoted must be exactly what the plan will be generated from.
 */
export function buildProposal(facts: ProposalFacts): ProposalMessage | null {
  if (facts.token.length > SLACK_ACTION_VALUE_MAX) {
    return null;
  }
  const quote = quoteForSlack(facts.goal);
  if (quote.length > PROPOSAL_QUOTE_MAX_CHARS) {
    return null;
  }
  const what =
    facts.mode === 'output-only' && facts.agentKey
      ? `an output-only plan built on the \`${escapeSlackText(facts.agentKey)}\` agent`
      : 'a plan that delivers a reviewed draft pull request';
  const text =
    `:memo: I can generate a plan for your request in *${escapeSlackText(facts.repoLabel)}* ` +
    `(${what}):\n${quote}`;
  return {
    blocks: [
      { text: { text, type: 'mrkdwn' }, type: 'section' },
      {
        elements: [
          {
            text:
              'Only you can generate this. A plan runs nothing: you review it and approve it ' +
              'in the dashboard first. This button expires in 15 minutes.',
            type: 'mrkdwn',
          },
        ],
        type: 'context',
      },
      {
        elements: [
          {
            action_id: SLACK_RUN_PLAN_ACTION_ID,
            style: 'primary',
            text: { emoji: true, text: 'Generate plan', type: 'plain_text' },
            type: 'button',
            value: facts.token,
          },
        ],
        type: 'actions',
      },
    ],
    // The notification fallback names no outside text.
    text: 'I can generate a plan for your request. Use the button to start it.',
  };
}

export const PROPOSAL_TEXT = {
  agentNotLaunchable:
    ":no_entry: I can't build a plan on that agent. Open the dashboard's *Start* page to pick one.",
  emptyGoal: ":information_source: I couldn't find a request in that message to plan.",
  incoherentMode:
    ':information_source: A plan is either a delivered pull request or an output-only agent ' +
    'plan, not both. Tell me which one you want.',
  linkAccount:
    ':lock: Generating a plan acts as you, so your Slack account has to be linked to auto-swe ' +
    'first. Link it in Settings, then ask me again.',
  needsEngineer: ':lock: Generating a plan needs the ENGINEER role on auto-swe.',
  noRepo:
    ":information_source: I couldn't tell which repository to plan for: this channel has none " +
    'linked, or several. Name the repository in your request (or ask an admin to link one), ' +
    'then ask me again.',
  signingUnavailable:
    ":warning: I can't offer a plan button right now (Slack signing is not configured). " +
    'Start it from the dashboard instead.',
  tooLong:
    ':information_source: That request is too long to confirm here. Shorten it, or start the ' +
    "plan from the dashboard's *Start* page.",
} as const;
