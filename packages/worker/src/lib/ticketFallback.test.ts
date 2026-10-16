import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn(), setting: vi.fn() }));

vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: mocks.setting }));
vi.mock('./ticketContext.js', () => ({ loadTicketContext: mocks.load }));

import { resolveTicketContext } from './ticketFallback.js';

const ARGS = { ctx: { teamId: 't-1' } as never, workRequestId: 'wr-1' };

beforeEach(() => {
  mocks.load.mockReset();
  mocks.setting.mockReset();
  mocks.setting.mockResolvedValue(false);
  mocks.load.mockResolvedValue('<ticket>fetched</ticket>');
});

describe('resolveTicketContext', () => {
  it('uses the ticket an earlier step handed in, and neither reads the setting nor fetches', async () => {
    expect(await resolveTicketContext('<ticket>from step</ticket>', ARGS)).toBe(
      '<ticket>from step</ticket>'
    );
    expect(mocks.setting).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('takes an empty string from a step as "the run has no ticket", even with the fallback on', async () => {
    mocks.setting.mockResolvedValue(true);
    expect(await resolveTicketContext('', ARGS)).toBe('');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('does not fetch when no step provided one and the setting is off', async () => {
    expect(await resolveTicketContext(undefined, ARGS)).toBe('');
    expect(mocks.setting).toHaveBeenCalledWith('workflow.ticketContextFallback', ARGS.ctx);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('fetches when no step provided one and the setting is on, passing the tracer along', async () => {
    mocks.setting.mockResolvedValue(true);
    const tracer = { addActivityEvent: vi.fn() };
    expect(await resolveTicketContext(undefined, { ...ARGS, tracer })).toBe(
      '<ticket>fetched</ticket>'
    );
    expect(mocks.load).toHaveBeenCalledWith({ tracer, workRequestId: 'wr-1' });
  });

  it('reads a failing setting as off, and a failing lookup as no ticket', async () => {
    mocks.setting.mockRejectedValue(new Error('db down'));
    expect(await resolveTicketContext(undefined, ARGS)).toBe('');
    expect(mocks.load).not.toHaveBeenCalled();

    mocks.setting.mockResolvedValue(true);
    mocks.load.mockRejectedValue(new Error('boom'));
    expect(await resolveTicketContext(undefined, ARGS)).toBe('');
  });
});
