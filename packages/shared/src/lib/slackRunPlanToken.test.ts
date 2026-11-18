import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type SlackRunPlanClaims,
  signSlackRunPlanToken,
  slackRunPlanIntentHash,
  verifySlackRunPlanToken,
} from './slackRunPlanToken.js';

const SECRET = 'signing-secret';
const NOW = 1_800_000_000_000;

function claims(overrides: Partial<SlackRunPlanClaims> = {}): SlackRunPlanClaims {
  const intent = overrides.intent ?? 'add a health endpoint';
  return {
    agentKey: null,
    channelId: 'C1',
    exp: NOW + 60_000,
    intent,
    intentHash: slackRunPlanIntentHash(intent),
    jti: 'a'.repeat(24),
    mode: 'delivering',
    repoId: '11111111-1111-4111-8111-111111111111',
    slackUserId: 'U1',
    threadTs: '1.2',
    ...overrides,
  };
}

describe('slack run plan token', () => {
  it('round-trips the claims', () => {
    const token = signSlackRunPlanToken(claims(), SECRET);
    const out = verifySlackRunPlanToken(token, SECRET, NOW);
    expect(out).toEqual({ claims: claims(), ok: true });
  });

  it('refuses a token signed with another secret, and one with a changed body', () => {
    const token = signSlackRunPlanToken(claims(), SECRET);
    expect(verifySlackRunPlanToken(token, 'other', NOW)).toEqual({
      issue: 'bad-signature',
      ok: false,
    });
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify(claims({ slackUserId: 'U2' }))).toString('base64url');
    expect(verifySlackRunPlanToken(`${forged}.${sig}`, SECRET, NOW)).toEqual({
      issue: 'bad-signature',
      ok: false,
    });
    expect(body).toBeTruthy();
  });

  it('refuses an expired token', () => {
    const token = signSlackRunPlanToken(claims({ exp: NOW - 1 }), SECRET);
    expect(verifySlackRunPlanToken(token, SECRET, NOW)).toEqual({ issue: 'expired', ok: false });
  });

  it('refuses malformed values', () => {
    for (const raw of [undefined, '', 'x', 'a.b.c', 'abc.def']) {
      expect(verifySlackRunPlanToken(raw, SECRET, NOW).ok).toBe(false);
    }
  });

  it('refuses a signed token whose intent does not match its hash', () => {
    const token = signSlackRunPlanToken(claims({ intentHash: 'f'.repeat(64) }), SECRET);
    expect(verifySlackRunPlanToken(token, SECRET, NOW)).toEqual({
      issue: 'malformed',
      ok: false,
    });
  });

  it('refuses a mode and agent that disagree', () => {
    const a = signSlackRunPlanToken(claims({ agentKey: 'docsMaintainer' }), SECRET);
    expect(verifySlackRunPlanToken(a, SECRET, NOW).ok).toBe(false);
    const b = signSlackRunPlanToken(claims({ agentKey: null, mode: 'output-only' }), SECRET);
    expect(verifySlackRunPlanToken(b, SECRET, NOW).ok).toBe(false);
    const c = signSlackRunPlanToken(
      claims({ agentKey: 'docsMaintainer', mode: 'output-only' }),
      SECRET
    );
    expect(verifySlackRunPlanToken(c, SECRET, NOW).ok).toBe(true);
  });

  it('does not accept a signature made for another purpose', () => {
    // A modal-metadata style signature over the same body has a different domain prefix.
    const token = signSlackRunPlanToken(claims(), SECRET);
    const [body] = token.split('.');
    const other = crypto.createHmac('sha256', SECRET).update(`hitl-modal:${body}`).digest('hex');
    expect(verifySlackRunPlanToken(`${body}.${other}`, SECRET, NOW).ok).toBe(false);
  });
});
