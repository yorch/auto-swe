import { describe, expect, it, vi } from 'vitest';

const { storeContextOverflowBatch } = vi.hoisted(() => ({ storeContextOverflowBatch: vi.fn() }));
vi.mock('./runnableActivities.js', () => ({ stateActivities: { storeContextOverflowBatch } }));
vi.mock('@temporalio/workflow', () => ({ patched: () => true }));

import { snapshotContext } from './runnableContext.js';

describe('snapshotContext spill placeholder', () => {
  // The dashboard finds this text with a regex (web ArtifactAwareText); the two must change together.
  it('writes exactly "[stored as artifact <id> — <bytes> bytes]" with an em dash', async () => {
    const id = '7a9619ff-8b86-4a08-8b86-3e6f9619ffd2';
    storeContextOverflowBatch.mockResolvedValue([{ artifactId: id, sizeBytes: 5001 }]);
    const snapshot = (await snapshotContext({ big: 'x'.repeat(5001) } as never, 'run-1')) as {
      big: string;
    };
    expect(snapshot.big).toBe(`[stored as artifact ${id} — 5001 bytes]`);
  });
});
