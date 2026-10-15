import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { agentFindMany, connectionFindMany, teamFindUnique } = vi.hoisted(() => ({
  agentFindMany: vi.fn(),
  connectionFindMany: vi.fn(),
  teamFindUnique: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agent: { findMany: agentFindMany },
    connection: { findMany: connectionFindMany },
    team: { findUnique: teamFindUnique },
  },
}));

vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));

const { fakeSpec } = vi.hoisted(() => ({ fakeSpec: { agentKey: 'workflowAuthor' } }));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn().mockResolvedValue(fakeSpec),
}));

vi.mock('./runAgent.js', () => ({ runAgent: vi.fn() }));

import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { generateWorkflowSpec } from './generateWorkflowSpec.js';
import { runAgent } from './runAgent.js';

const mockedRunAgent = vi.mocked(runAgent);
const mockedResolveSpec = vi.mocked(resolveAgentSpec);

const VALID_SPEC = {
  description: 'demo',
  entry: 'done',
  name: 'Demo',
  nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};

function out(specJson: string, summary = 's') {
  return { object: { specJson, summary } };
}

beforeEach(() => {
  vi.clearAllMocks();
  agentFindMany.mockResolvedValue([
    { description: 'Writes code', key: 'implementer', name: 'Implementer' },
  ]);
  connectionFindMany.mockResolvedValue([]);
  teamFindUnique.mockResolvedValue({ shellImageAllowlist: [] });
});

describe('generateWorkflowSpec', () => {
  it('returns the validated spec on a valid first attempt', async () => {
    mockedRunAgent.mockResolvedValueOnce(out(JSON.stringify(VALID_SPEC)));

    const result = await generateWorkflowSpec({ prompt: 'build a demo', teamId: 'team-1' });

    expect(result.attempts).toBe(1);
    expect(result.summary).toBe('s');
    expect(result.spec.entry).toBe('done');
    expect(mockedRunAgent).toHaveBeenCalledTimes(1);

    // Author spec resolved at the team scope, with the structured-output schema.
    expect(mockedResolveSpec).toHaveBeenCalledWith(
      expect.objectContaining({ agentKey: 'workflowAuthor', outputSchema: expect.anything() }),
      { teamId: 'team-1' }
    );
    // The first user message carries the intent + the catalog of building blocks.
    const msg = mockedRunAgent.mock.calls[0][1] as string;
    expect(msg).toContain('build a demo');
    expect(msg).toContain('implementer');
  });

  it('repairs invalid JSON, then succeeds, feeding the error back', async () => {
    mockedRunAgent
      .mockResolvedValueOnce(out('{ not json'))
      .mockResolvedValueOnce(out(JSON.stringify(VALID_SPEC)));

    const result = await generateWorkflowSpec({ prompt: 'x', teamId: 'team-1' });

    expect(result.attempts).toBe(2);
    expect(mockedRunAgent).toHaveBeenCalledTimes(2);
    const repairMsg = mockedRunAgent.mock.calls[1][1] as string;
    expect(repairMsg).toContain('not valid JSON');
    expect(repairMsg).toContain('PREVIOUS ATTEMPT');
  });

  it('repairs a schema-invalid spec, then succeeds', async () => {
    // entry points at a non-existent node → superRefine error.
    const broken = { ...VALID_SPEC, entry: 'missing' };
    mockedRunAgent
      .mockResolvedValueOnce(out(JSON.stringify(broken)))
      .mockResolvedValueOnce(out(JSON.stringify(VALID_SPEC)));

    const result = await generateWorkflowSpec({ prompt: 'x', teamId: 'team-1' });

    expect(result.attempts).toBe(2);
    const repairMsg = mockedRunAgent.mock.calls[1][1] as string;
    expect(repairMsg).toContain('missing');
  });

  it('sends a repair message (not the original) when the model omits specJson', async () => {
    mockedRunAgent
      .mockResolvedValueOnce({ object: { summary: 'oops' } } as never)
      .mockResolvedValueOnce(out(JSON.stringify(VALID_SPEC)));

    const result = await generateWorkflowSpec({ prompt: 'x', teamId: 'team-1' });

    expect(result.attempts).toBe(2);
    const repairMsg = mockedRunAgent.mock.calls[1][1] as string;
    expect(repairMsg).toContain('specJson');
    expect(repairMsg).toContain('ERRORS');
  });

  it('throws after exhausting all attempts on persistent invalid output', async () => {
    mockedRunAgent.mockResolvedValue(out('{ still not json'));

    await expect(generateWorkflowSpec({ prompt: 'x', teamId: 'team-1' })).rejects.toThrow(
      /could not produce a valid WorkflowSpec after 3 attempts/
    );
    expect(mockedRunAgent).toHaveBeenCalledTimes(3);
  });

  describe('authored code without shell authorization', () => {
    const CONTAINER_SPEC = {
      ...VALID_SPEC,
      entry: 'run',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        run: {
          config: { image: 'alpine:latest' },
          next: 'done',
          step: 'runContainerStep',
          type: 'step',
        },
      },
    };
    const COMMAND_SPEC = {
      ...VALID_SPEC,
      entry: 'lint',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        lint: { config: { command: 'curl x | sh' }, next: 'done', step: 'runLint', type: 'step' },
      },
    };

    it.each([
      ['a runContainerStep step', CONTAINER_SPEC, 'runs a container'],
      ['an authored gate command', COMMAND_SPEC, 'sets a `command`'],
    ])('repairs %s away when shell is not allowed', async (_label, bad, issue) => {
      mockedRunAgent
        .mockResolvedValueOnce(out(JSON.stringify(bad)))
        .mockResolvedValueOnce(out(JSON.stringify(VALID_SPEC)));

      const result = await generateWorkflowSpec({ prompt: 'x', teamId: 'team-1' });

      expect(result.attempts).toBe(2);
      expect(result.spec.nodes).toEqual(VALID_SPEC.nodes);
      const repairMsg = mockedRunAgent.mock.calls[1][1] as string;
      expect(repairMsg).toContain(issue);
    });

    it('keeps authored code when shell is allowed', async () => {
      mockedRunAgent.mockResolvedValueOnce(out(JSON.stringify(COMMAND_SPEC)));

      const result = await generateWorkflowSpec({
        allowShell: true,
        prompt: 'x',
        teamId: 'team-1',
      });

      expect(result.attempts).toBe(1);
      expect(Object.keys(result.spec.nodes)).toContain('lint');
    });

    it('does not ask a refinement to drop authored code carried over unchanged', async () => {
      const baseSpec = parseWorkflowSpec(COMMAND_SPEC);
      mockedRunAgent.mockResolvedValueOnce(out(JSON.stringify(COMMAND_SPEC)));

      const result = await generateWorkflowSpec({
        baseSpec,
        prompt: 'rename it',
        teamId: 'team-1',
      });

      // Left for the caller's own refusal, which points the user at the canvas.
      expect(result.attempts).toBe(1);
    });
  });

  it('does not query mcp connections when no team scope is given', async () => {
    mockedRunAgent.mockResolvedValueOnce(out(JSON.stringify(VALID_SPEC)));

    await generateWorkflowSpec({ prompt: 'x', teamId: null });

    expect(connectionFindMany).not.toHaveBeenCalled();
    expect(mockedResolveSpec).toHaveBeenCalledWith(expect.anything(), { teamId: undefined });
  });
});
