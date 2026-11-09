/**
 * Slack cards for the step-failure and PR-ready notices. Like the run-complete card they are built
 * entirely by fixed code (no model), pass through the same validator, and return `null` when the
 * spec is refused, so the caller posts the plain one-line notice it always has. A card is an
 * upgrade, never a reason to lose the notification. Pure and I/O-free.
 */
import { clip, codeSafe } from './runCompleteCard.js';
import { parseSlackCard, renderSlackCard } from './slackCard.js';

export interface StepFailureCardInput {
  ticket: string;
  templateName: string;
  nodeId: string;
  attempt: number;
  /** The raw error text; clipped here, escaped when rendered. */
  error?: string | undefined;
  /** Absolute dashboard URL of the run; its host must equal `dashboardHost`. */
  runUrl: string;
  dashboardHost: string;
}

/** The longest error text a card carries. */
const MAX_ERROR_CHARS = 400;

export function buildStepFailureCard(
  input: StepFailureCardInput
): { blocks: unknown[]; text: string } | null {
  const ticket = codeSafe(input.ticket);
  const template = codeSafe(input.templateName);
  const node = codeSafe(input.nodeId);
  // A code fence of its own: backticks in the error are swapped so it cannot end the fence early.
  const error = input.error?.trim()
    ? clip(input.error.replace(/`/g, "'").trim(), MAX_ERROR_CHARS)
    : null;

  const parsed = parseSlackCard(
    {
      blocks: [
        { text: `:rotating_light: *[${ticket}]* \`${template}\` — a step failed`, type: 'text' },
        {
          items: [
            { label: 'Step', value: node },
            { label: 'Attempt', value: String(input.attempt) },
          ],
          type: 'fields',
        },
        ...(error ? [{ text: `\`\`\`\n${error}\n\`\`\``, type: 'text' }] : []),
        { items: [{ label: 'Open run', url: input.runUrl }], type: 'buttons' },
      ],
      summary: clip(
        `:rotating_light: [${ticket}] ${template} → step ${node} failed (attempt ${input.attempt})${error ? `: ${error}` : ''}`,
        300
      ),
    },
    { allowedLinkHosts: [input.dashboardHost] }
  );
  return parsed.ok ? renderSlackCard(parsed.card) : null;
}

export interface PrReadyCardInput {
  ticket: string;
  prNumber: number;
  prUrl: string;
  /** `host[:port]` values the PR button may link to: the dashboard and the approved repository hosts. */
  allowedLinkHosts: readonly string[];
}

export function buildPrReadyCard(
  input: PrReadyCardInput
): { blocks: unknown[]; text: string } | null {
  const ticket = codeSafe(input.ticket);
  const parsed = parseSlackCard(
    {
      blocks: [
        { text: `:eyes: *[${ticket}]* PR #${input.prNumber} is ready for review`, type: 'text' },
        { items: [{ label: 'Open PR', url: input.prUrl }], type: 'buttons' },
      ],
      summary: clip(`:eyes: [${ticket}] PR #${input.prNumber} is ready for review`, 300),
    },
    { allowedLinkHosts: input.allowedLinkHosts }
  );
  return parsed.ok ? renderSlackCard(parsed.card) : null;
}
