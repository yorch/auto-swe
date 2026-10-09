import { describe, expect, it } from 'vitest';
import {
  type CoverageAgent,
  type CoverageCredential,
  type CoverageInput,
  credentialGaps,
  embeddingCoverageGap,
  gapsOpenedByRemoving,
} from './credentialCoverage.js';

function agent(over: Partial<CoverageAgent> = {}): CoverageAgent {
  return {
    channelId: null,
    credentialId: null,
    inheritsModelFrom: null,
    key: 'reviewer',
    modelSpec: 'anthropic/claude-opus-5-5',
    orgId: null,
    scope: 'GLOBAL',
    teamId: null,
    workflowTemplateId: null,
    ...over,
  };
}

function cred(over: Partial<CoverageCredential> = {}): CoverageCredential {
  return {
    hasApiBase: false,
    id: 'c-global-anthropic',
    orgId: null,
    provider: 'anthropic',
    scope: 'GLOBAL',
    teamId: null,
    ...over,
  };
}

function input(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    agents: [],
    credentials: [],
    embedding: { credentialId: null, modelSpec: 'openai/text-embedding-3-large' },
    teamOrgs: new Map(),
    ...over,
  };
}

const agentGaps = (i: CoverageInput) => credentialGaps(i).filter((g) => g.subject !== 'embeddings');

describe('credentialGaps — agents', () => {
  it('covers a GLOBAL agent with a GLOBAL credential for its provider', () => {
    expect(agentGaps(input({ agents: [agent()], credentials: [cred()] }))).toEqual([]);
  });

  it('reports a GLOBAL agent whose provider has no GLOBAL credential, even with a team one', () => {
    const gaps = agentGaps(
      input({
        agents: [agent()],
        credentials: [cred({ id: 'c-team', scope: 'TEAM', teamId: 't-1' })],
      })
    );
    expect(gaps).toEqual([
      expect.objectContaining({
        problem: 'no-credential',
        provider: 'anthropic',
        subject: 'reviewer',
      }),
    ]);
  });

  it('covers a TEAM agent through its team, its organization, or GLOBAL', () => {
    const team = agent({ scope: 'TEAM', teamId: 't-1' });
    const orgs = new Map([['t-1', 'o-1']]);
    for (const c of [
      cred({ scope: 'TEAM', teamId: 't-1' }),
      cred({ orgId: 'o-1', scope: 'ORGANIZATION' }),
      cred(),
    ]) {
      expect(agentGaps(input({ agents: [team], credentials: [c], teamOrgs: orgs }))).toEqual([]);
    }
    expect(
      agentGaps(
        input({
          agents: [team],
          credentials: [
            cred({ scope: 'TEAM', teamId: 't-2' }),
            cred({ orgId: 'o-2', scope: 'ORGANIZATION' }),
          ],
          teamOrgs: orgs,
        })
      )
    ).toHaveLength(1);
  });

  it('follows inheritsModelFrom to the parent’s provider', () => {
    const gaps = agentGaps(
      input({
        agents: [
          agent({ inheritsModelFrom: 'reviewer', key: 'securityReviewer', modelSpec: null }),
          agent({ key: 'reviewer', modelSpec: 'openrouter/openai/gpt-6-luna' }),
        ],
        credentials: [cred()],
      })
    );
    expect(gaps.map((g) => [g.subject, g.provider])).toEqual([
      ['securityReviewer', 'openrouter'],
      ['reviewer', 'openrouter'],
    ]);
  });

  it('reports an agent whose model chain resolves nothing', () => {
    const gaps = agentGaps(
      input({ agents: [agent({ inheritsModelFrom: 'gone', key: 'persona', modelSpec: null })] })
    );
    expect(gaps).toEqual([expect.objectContaining({ problem: 'no-model', subject: 'persona' })]);
  });

  it('uses a usable pin, and falls back to the cascade when the pin is unusable', () => {
    const pinned = agent({ credentialId: 'c-pin', modelSpec: 'openrouter/x' });
    const pin = cred({ hasApiBase: true, id: 'c-pin', provider: 'openrouter' });
    expect(agentGaps(input({ agents: [pinned], credentials: [pin] }))).toEqual([]);
    // A TEAM pin is out of reach for a GLOBAL agent at boot.
    expect(
      agentGaps(
        input({ agents: [pinned], credentials: [{ ...pin, scope: 'TEAM', teamId: 't-1' }] })
      )
    ).toEqual([expect.objectContaining({ problem: 'no-credential' })]);
  });

  it('requires an apiBase on the credential a non-built-in provider resolves to', () => {
    const gaps = agentGaps(
      input({
        agents: [agent({ modelSpec: 'opencode-go/glm-5.2' })],
        credentials: [cred({ id: 'c-go', provider: 'opencode-go' })],
      })
    );
    expect(gaps).toEqual([
      expect.objectContaining({ problem: 'no-api-base', provider: 'opencode-go' }),
    ]);
  });

  it('counts any credential for a CHANNEL or WORKFLOW_TEMPLATE agent', () => {
    const channel = agent({ channelId: 'ch-1', scope: 'CHANNEL' });
    expect(
      agentGaps(input({ agents: [channel], credentials: [cred({ scope: 'TEAM', teamId: 't-9' })] }))
    ).toEqual([]);
  });

  it('reports an invalid spec', () => {
    expect(agentGaps(input({ agents: [agent({ modelSpec: 'nope' })] }))).toEqual([
      expect.objectContaining({ problem: 'invalid-spec' }),
    ]);
  });
});

describe('embeddingCoverageGap', () => {
  const openai = cred({ id: 'c-openai', provider: 'openai' });

  it('is covered by a GLOBAL credential for its provider', () => {
    expect(embeddingCoverageGap(input({ credentials: [openai] }))).toBeNull();
  });

  it('reports a missing config, a missing credential, Anthropic, and a mismatched pin', () => {
    expect(embeddingCoverageGap(input({ embedding: null }))?.problem).toBe('no-embedding-config');
    expect(embeddingCoverageGap(input())?.problem).toBe('no-credential');
    expect(
      embeddingCoverageGap(
        input({ embedding: { credentialId: null, modelSpec: 'anthropic/claude-opus-5-5' } })
      )?.problem
    ).toBe('unsupported-embedding-provider');
    expect(
      embeddingCoverageGap(
        input({
          credentials: [cred()],
          embedding: {
            credentialId: 'c-global-anthropic',
            modelSpec: 'openai/text-embedding-3-large',
          },
        })
      )?.problem
    ).toBe('pin-provider-mismatch');
  });
});

describe('gapsOpenedByRemoving', () => {
  const global = cred();
  const team = cred({ id: 'c-team', scope: 'TEAM', teamId: 't-1' });
  const teamAgent = agent({ key: 'teamReviewer', scope: 'TEAM', teamId: 't-1' });

  it('names what only this credential covered', () => {
    const i = input({
      agents: [agent(), teamAgent],
      credentials: [global, team, cred({ id: 'c-openai', provider: 'openai' })],
    });
    // The team agent still has its team credential; the GLOBAL agent has nothing.
    expect(gapsOpenedByRemoving(i, global.id).map((g) => g.subject)).toEqual(['reviewer']);
    // The team agent falls back to GLOBAL.
    expect(gapsOpenedByRemoving(i, team.id)).toEqual([]);
  });

  it('includes the embedding model and ignores gaps that already existed', () => {
    const openai = cred({ id: 'c-openai', provider: 'openai' });
    const i = input({ agents: [agent({ modelSpec: 'mistral/x' })], credentials: [openai] });
    expect(gapsOpenedByRemoving(i, openai.id).map((g) => g.subject)).toEqual(['embeddings']);
  });

  it('names a pinned agent when no other credential is in its reach', () => {
    const pin = cred({ id: 'c-pin', scope: 'GLOBAL' });
    const i = input({
      agents: [agent({ credentialId: 'c-pin' })],
      credentials: [pin, { ...global, id: 'c-other', orgId: 'o-1', scope: 'ORGANIZATION' }],
    });
    // The only other anthropic credential is out of a GLOBAL agent's reach.
    expect(gapsOpenedByRemoving(i, 'c-pin').map((g) => g.subject)).toEqual(['reviewer']);
  });
});
