import { describe, expect, it, vi } from 'vitest';

const publishOutcome = vi.fn(async () => ({ decision: 'auto' }));

vi.mock('./runnableActivities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runnableActivities.js')>();
  return {
    ...actual,
    genericActivities: { ...actual.genericActivities, publishOutcome },
  };
});

const { dispatchStepImpl } = await import('./runnableSteps.js');

const ctx = { workflow: { id: 'wf-1' } } as never;

describe('the publishOutcome step and its risk class', () => {
  it('takes the class from the config, never from a bindable input', async () => {
    // The class decides how the run is judged, so a payload-fillable class is a class the
    // *launcher* chooses: binding one the policy auto-approves would walk a write through a gate
    // the claimant set. The registry declares the field as `config`, and the executor reads only
    // that — this asserts the input is ignored even when both are present.
    await dispatchStepImpl(
      'publishOutcome',
      ctx,
      {} as never,
      { action: 'internal_write' },
      { action: { from: 'request.payload.action' } },
      'do'
    );

    expect(publishOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'internal_write' })
    );
  });

  it('falls back to the registry default when the config names no class', async () => {
    await dispatchStepImpl('publishOutcome', ctx, {} as never, {}, {}, 'do');

    expect(publishOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'external_communication' })
    );
  });
});
