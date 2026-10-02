import { defaultPayloadConverter } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { NODE_TAG_HEADER } from '../workflows/nodeTag.js';
import { activityNodeTagInterceptor, currentNodeTag, nodeTagColumns } from './activityNodeTag.js';

const run = async (headers: Record<string, unknown> | undefined) => {
  const { inbound } = activityNodeTagInterceptor();
  let seen: ReturnType<typeof currentNodeTag>;
  // The interceptor's `next` stands in for the activity body.
  await inbound?.execute?.({ args: [], headers: (headers ?? {}) as never }, async () => {
    await Promise.resolve();
    seen = currentNodeTag();
    return undefined;
  });
  return seen;
};

describe('activityNodeTagInterceptor', () => {
  it('exposes the header the workflow stamped to the activity body', async () => {
    const tag = { recordingId: 'fan[0]/impl', specNodeId: 'impl', stepAttempt: 2 };
    const seen = await run({ [NODE_TAG_HEADER]: defaultPayloadConverter.toPayload(tag) });
    expect(seen).toEqual(tag);
  });

  it('leaves the activity untagged when there is no header', async () => {
    expect(await run({})).toBeUndefined();
    expect(currentNodeTag()).toBeUndefined();
  });

  it.each([
    ['a payload of the wrong shape', defaultPayloadConverter.toPayload({ specNodeId: 3 })],
    ['a payload that is not decodable', { data: new Uint8Array([1]), metadata: {} }],
  ])('ignores %s instead of failing the activity', async (_label, payload) => {
    expect(await run({ [NODE_TAG_HEADER]: payload })).toBeUndefined();
  });

  it('maps a missing tag to NULL columns', () => {
    expect(nodeTagColumns(undefined)).toEqual({
      recordingId: null,
      specNodeId: null,
      stepAttempt: null,
    });
  });
});
