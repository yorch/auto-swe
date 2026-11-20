import {
  SLACK_ACTION_VALUE_MAX,
  SLACK_RUN_PLAN_ACTION_ID,
} from '@auto-swe/shared/lib/slackRunPlanToken';
import { RUN_PLAN_INTENT_MAX_CHARS } from '@auto-swe/shared/workflow/runPlan';
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
 * The goal: the invoking person's own message text as plain text, never a model's output.
 *
 * Slack delivers message text entity-escaped, with its own markup as angle-bracket tokens, so the
 * goal is made from it in a fixed order: tokens first (`<@U…>` a mention, dropped; `<#C…|name>` a
 * channel, kept as `#name`; `<!here>`, `<!channel>`, `<!subteam^…>` and `<!date^…>` broadcasts and
 * dates, dropped; `<https://x|label>` a link, kept as its label, and `<https://x>` as the URL), and
 * only then the three entities `&amp;`, `&lt;` and `&gt;`, once. A literal `<` the person typed
 * arrives as `&lt;`, so decoding last means decoded text can never be read as a token here, and the
 * text is escaped again wherever it is shown (`quoteForSlack`). What results goes through
 * `runPlanIntentIssue` like any other goal.
 */
export function goalFromSlackMessage(userText: string): string {
  if (userText.length > SLACK_RAW_GOAL_MAX_CHARS) {
    return '';
  }
  return stripSlackTokens(userText)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * The longest raw Slack message text that is parsed at all: four times the longest goal a plan may
 * carry, which leaves room for the markup Slack wraps around mentions and links. Longer text is
 * refused before any scanning (see `goalFromSlackMessage`).
 */
export const SLACK_RAW_GOAL_MAX_CHARS = 4 * RUN_PLAN_INTENT_MAX_CHARS;

const isAlnum = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9]$/.test(c);
const isSchemeChar = (c: string | undefined): boolean =>
  c !== undefined && /^[A-Za-z0-9+.-]$/.test(c);
const isSpace = (c: string): boolean => /^\s$/.test(c);

/**
 * Replace every Slack angle-bracket token in one left-to-right pass. A token runs from `<` to the
 * first `>` after it, and the position of that `>` is found once per stretch of text and reused,
 * so text full of unmatched `<` costs time linear in its length (a regex per token kind rescans to
 * the end for every `<`, which is quadratic). `failUntil` plays the same part for a link whose
 * address runs into whitespace: every later `<` inside that run fails at the same place.
 */
function stripSlackTokens(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  let at = 0;
  let gt = -1;
  let failUntil = -1;
  while (true) {
    const lt = text.indexOf('<', at);
    if (lt < 0) {
      break;
    }
    if (gt < lt) {
      gt = text.indexOf('>', lt);
      if (gt < 0) {
        break;
      }
    }
    const kind = text[lt + 1];
    let replacement: string | null = null;
    if (kind === '!') {
      replacement = ' ';
    } else if (kind === '@' || kind === '#') {
      let j = lt + 2;
      while (isAlnum(text[j])) {
        j += 1;
      }
      if (j > lt + 2 && (j === gt || (text[j] === '|' && j < gt))) {
        if (kind === '@') {
          replacement = ' ';
        } else {
          const name = j === gt ? '' : text.slice(j + 1, gt);
          replacement = name ? `#${name}` : ' ';
        }
      }
    } else if (kind !== undefined && /^[A-Za-z]$/.test(kind)) {
      let j = lt + 2;
      while (isSchemeChar(text[j])) {
        j += 1;
      }
      if (text[j] === ':' && j + 1 > failUntil) {
        j += 1;
        while (j < gt && text[j] !== '|' && !isSpace(text[j] as string)) {
          j += 1;
        }
        if (j === gt) {
          replacement = text.slice(lt + 1, gt);
        } else if (text[j] === '|') {
          const label = text.slice(j + 1, gt);
          replacement = label ? label : text.slice(lt + 1, j);
        } else {
          failUntil = j;
        }
      }
    }
    if (replacement === null) {
      at = lt + 1;
    } else {
      parts.push(text.slice(copied, lt), replacement);
      copied = gt + 1;
      at = copied;
    }
  }
  parts.push(text.slice(copied));
  return parts.join('');
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
  needsEngineer: ':lock: Generating a plan needs an active user account on auto-swe.',
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
