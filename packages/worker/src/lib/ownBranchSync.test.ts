import { describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/activity', () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type: string) => Object.assign(new Error(message), { type }),
  },
}));

import { runTrailer, syncToOwnPush } from './ownBranchSync.js';

function workspace(tip: string, fetchFails = false) {
  const commands: string[] = [];
  return {
    commands,
    exec: vi.fn(async (command: string) => {
      commands.push(command);
      return command.startsWith('git log') ? tip : '';
    }),
    gitAuthed: vi.fn(async () => {
      if (fetchFails) {
        throw new Error("couldn't find remote ref");
      }
    }),
  };
}

describe('syncToOwnPush', () => {
  it('moves onto a branch whose tip this run made', async () => {
    const ws = workspace(`auto: implement PAY-1\n\n${runTrailer('wr-1')}\n`);
    expect(await syncToOwnPush(ws, 'auto/PAY-1', 'wr-1')).toBe(true);
    expect(ws.commands).toContain("git reset --hard origin/'auto/PAY-1'");
  });

  it('refuses, non-retryably and without resetting, a branch another run made', async () => {
    const ws = workspace(`auto: implement PAY-1\n\n${runTrailer('wr-OTHER')}\n`);
    await expect(syncToOwnPush(ws, 'auto/PAY-1', 'wr-1')).rejects.toMatchObject({
      type: 'BRANCH_NOT_OWNED',
    });
    expect(ws.commands.some((c) => c.startsWith('git reset'))).toBe(false);
  });

  it('refuses a tip that names no run, such as a person’s commit', async () => {
    const ws = workspace('fix typo');
    await expect(syncToOwnPush(ws, 'auto/PAY-1', 'wr-1')).rejects.toMatchObject({
      type: 'BRANCH_NOT_OWNED',
    });
  });

  it('stays at the clone when no branch was pushed yet', async () => {
    const ws = workspace('', true);
    expect(await syncToOwnPush(ws, 'auto/PAY-1', 'wr-1')).toBe(false);
    expect(ws.commands).toEqual([]);
  });

  it('does not take a run whose id only starts with this one’s for this run', async () => {
    const ws = workspace(`x\n\n${runTrailer('wr-10')}`);
    await expect(syncToOwnPush(ws, 'auto/PAY-1', 'wr-1')).rejects.toMatchObject({
      type: 'BRANCH_NOT_OWNED',
    });
  });
});
