import { describe, expect, it } from 'vitest';
import type { Context } from '../expr.js';
import { type Dispatcher, runSpec } from '../interpreter.js';
import { TICKET_TO_MERGE_SPEC } from './ticketToMerge.js';

/** What `validate` returned for the run; `null` is a validate step that threw (`onError: continue`). */
type ValidateOutcome =
  | { actionable?: boolean; ambiguities?: string[]; successCriteria: string[] }
  | 'throws';

/**
 * Drives the real template. The run stops being interesting at `implement`: the dispatcher throws
 * a marker there, so a run that reaches it fails with that marker and a run that stops earlier
 * ends at a terminate node.
 */
async function run(
  validate: ValidateOutcome,
  ticket: { available: boolean; text: string; unavailableReason?: string }
) {
  const steps: string[] = [];
  const dispatcher: Dispatcher = {
    async dispatchStep({ step }) {
      steps.push(step);
      switch (step) {
        case 'updateDomainState':
          return {};
        case 'gatherTicketContext':
          return {
            available: ticket.available,
            digested: ticket.available,
            text: ticket.text,
            unavailableReason: ticket.unavailableReason ?? '',
          };
        case 'validateContext':
          if (validate === 'throws') {
            throw new Error('provider down');
          }
          return { contextSnapshotId: 'cs-1', ...validate };
        case 'executeImplementation':
          throw new Error('REACHED_IMPLEMENT');
        default:
          throw new Error(`unexpected step ${step}`);
      }
    },
    async recordStep() {},
    async waitSignal() {
      return undefined;
    },
  };
  const ctx: Context = {
    context: {},
    nodes: {},
    request: {
      description: 'https://sentinelone.atlassian.net/browse/SHMC-798',
      externalTicketId: 'SHMC-798',
      repoId: 'r-1',
    },
    workflow: { id: 'eng-t-1' },
  };
  const outcome = await runSpec(TICKET_TO_MERGE_SPEC, ctx, dispatcher).then(
    (result) => ({ reachedImplement: false, result }),
    (err: unknown) => {
      if (err instanceof Error && err.message.includes('REACHED_IMPLEMENT')) {
        return { reachedImplement: true, result: undefined };
      }
      throw err;
    }
  );
  return { ...outcome, steps };
}

const NO_TICKET = { available: false, text: '' };

describe('ticket-to-merge stops before implement when the request is not actionable', () => {
  it('stops at a failed terminate that says what is missing, and never implements', async () => {
    const reason = 'AMBIGUOUS: the request is only a Jira URL';
    const { reachedImplement, result, steps } = await run(
      {
        actionable: false,
        ambiguities: ['the request is only a Jira URL'],
        successCriteria: [reason],
      },
      NO_TICKET
    );
    expect(reachedImplement).toBe(false);
    expect(steps).not.toContain('executeImplementation');
    expect(result?.status).toBe('FAILED');
    expect(result?.result).toMatchObject({
      ambiguities: ['the request is only a Jira URL'],
      message: expect.stringContaining('not actionable'),
    });
    expect(String(result?.result.message)).toContain('re-run');
  });

  it('says why the ticket could not be read when the stop follows a refused fetch', async () => {
    const { result } = await run(
      {
        actionable: false,
        ambiguities: ['only a URL'],
        successCriteria: ['AMBIGUOUS: only a URL'],
      },
      { available: false, text: '', unavailableReason: 'forbidden' }
    );
    expect(result?.result).toMatchObject({ ticketUnavailableReason: 'forbidden' });
  });

  it('leaves that reason empty when no ticket fetch failed', async () => {
    const { result } = await run(
      {
        actionable: false,
        ambiguities: ['only a URL'],
        successCriteria: ['AMBIGUOUS: only a URL'],
      },
      NO_TICKET
    );
    expect(result?.result).toMatchObject({ ticketUnavailableReason: '' });
  });

  it('implements when validate found a real criterion', async () => {
    const { reachedImplement, steps } = await run(
      { actionable: true, ambiguities: [], successCriteria: ['GET /health returns 200'] },
      { available: true, text: 'Add a health endpoint' }
    );
    expect(reachedImplement).toBe(true);
    expect(steps).toContain('validateContext');
  });

  it('implements an actionable description even though the ticket was unavailable', async () => {
    const { reachedImplement } = await run(
      {
        actionable: true,
        ambiguities: ['no pagination limit stated'],
        successCriteria: ['GET /health returns 200', 'AMBIGUOUS: no pagination limit stated'],
      },
      NO_TICKET
    );
    expect(reachedImplement).toBe(true);
  });

  it('implements when validate threw: a failed check is not a verdict', async () => {
    const { reachedImplement } = await run('throws', NO_TICKET);
    expect(reachedImplement).toBe(true);
  });

  it('implements when validate predates the verdict field (an older activity result)', async () => {
    const { reachedImplement } = await run({ successCriteria: [] }, NO_TICKET);
    expect(reachedImplement).toBe(true);
  });
});
