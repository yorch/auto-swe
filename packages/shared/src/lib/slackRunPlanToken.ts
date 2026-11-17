import crypto from 'node:crypto';

/**
 * The token a Slack "Generate plan" button carries as its `value`.
 *
 * The channel assistant records an intent to propose a plan; fixed worker code then posts a
 * confirmation whose button holds this token, and the gateway verifies it when the button is
 * clicked. It is signed with the Slack signing secret (both processes resolve the same one), under
 * its own domain prefix so a signature made for another purpose cannot stand in for it.
 *
 * What it binds, all chosen by fixed code and none by a model:
 *
 * - `slackUserId`: only the person whose message is the goal may click it;
 * - `channelId` and `threadTs`: the message it was posted in;
 * - `intent` and `intentHash`: the goal, verbatim, so the gateway needs no store to learn it. The
 *   text is carried in the value Slack echoes back, and the hash is checked again on verification;
 * - `repoId`, `mode` and `agentKey`: what the plan is for;
 * - `jti` and `exp`: a random id the gateway derives its Idempotency-Key from (so a second click
 *   finds the first one's job rather than starting another) and an expiry.
 *
 * A token is not a credential: the gateway still acts as the platform user the clicker's Slack id
 * links to, and re-checks role, repository reach and quotas at click time.
 */

export const SLACK_RUN_PLAN_ACTION_ID = 'run_plan_generate';
/** Slack caps a button `value` at 2000 characters. */
export const SLACK_ACTION_VALUE_MAX = 2000;
/** How long a proposal stays clickable. */
export const SLACK_RUN_PLAN_TOKEN_TTL_MS = 15 * 60_000;

export interface SlackRunPlanClaims {
  /** Random id; the gateway derives the generation's Idempotency-Key from it. */
  jti: string;
  slackUserId: string;
  /** The Slack channel id (`C…`) the proposal was posted in. */
  channelId: string;
  threadTs: string;
  intent: string;
  intentHash: string;
  repoId: string;
  mode: 'delivering' | 'output-only';
  agentKey: string | null;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export type SlackRunPlanTokenIssue = 'malformed' | 'bad-signature' | 'expired';

export function slackRunPlanIntentHash(intent: string): string {
  return crypto.createHash('sha256').update(`slack-run-plan-intent\n${intent}`).digest('hex');
}

function hmacHex(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(`slack-run-plan:${data}`).digest('hex');
}

export function signSlackRunPlanToken(claims: SlackRunPlanClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${hmacHex(secret, body)}`;
}

const MODES = new Set(['delivering', 'output-only']);

export function verifySlackRunPlanToken(
  raw: string | undefined,
  secret: string,
  now: number = Date.now()
): { ok: true; claims: SlackRunPlanClaims } | { ok: false; issue: SlackRunPlanTokenIssue } {
  const [body, sig, ...rest] = (raw ?? '').split('.');
  if (!body || !sig || rest.length > 0) {
    return { issue: 'malformed', ok: false };
  }
  const expected = Buffer.from(hmacHex(secret, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { issue: 'bad-signature', ok: false };
  }
  let c: Partial<SlackRunPlanClaims>;
  try {
    c = JSON.parse(Buffer.from(body, 'base64url').toString()) as Partial<SlackRunPlanClaims>;
  } catch {
    return { issue: 'malformed', ok: false };
  }
  if (
    typeof c !== 'object' ||
    c === null ||
    typeof c.jti !== 'string' ||
    !/^[0-9a-f]{16,64}$/.test(c.jti) ||
    typeof c.slackUserId !== 'string' ||
    !c.slackUserId ||
    typeof c.channelId !== 'string' ||
    !c.channelId ||
    typeof c.threadTs !== 'string' ||
    !c.threadTs ||
    typeof c.intent !== 'string' ||
    !c.intent ||
    typeof c.intentHash !== 'string' ||
    typeof c.repoId !== 'string' ||
    typeof c.mode !== 'string' ||
    !MODES.has(c.mode) ||
    (c.agentKey !== null && typeof c.agentKey !== 'string') ||
    typeof c.exp !== 'number' ||
    // The signed intent must still be the text the hash names.
    c.intentHash !== slackRunPlanIntentHash(c.intent) ||
    (c.mode === 'output-only') !== (typeof c.agentKey === 'string')
  ) {
    return { issue: 'malformed', ok: false };
  }
  if (c.exp <= now) {
    return { issue: 'expired', ok: false };
  }
  return { claims: c as SlackRunPlanClaims, ok: true };
}
