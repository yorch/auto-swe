import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, fail: false, rows: [] as Record<string, unknown>[] }));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: async (key: string) => (key === 'workflow.httpCaptureEnabled' ? h.enabled : 8192),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    workflowHttpCall: {
      createMany: vi.fn(async ({ data }) => {
        if (h.fail) {
          throw new Error('unavailable');
        }
        h.rows.push(...data);
      }),
    },
  },
}));
vi.mock('./activityContext.js', () => ({
  currentActivityType: () => 'test',
  currentAttempt: () => 2,
  currentTemporalRunId: () => 'temporal',
  currentWorkflowId: () => 'workflow',
  currentWorkflowRunId: async () => 'run',
}));
vi.mock('./spendOwner.js', () => ({
  currentSpendOwner: async () => ({ orgId: 'org', teamId: 'team' }),
}));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));
vi.mock('./transcriptRecorder.js', async () => {
  const actual =
    await vi.importActual<typeof import('./transcriptRecorder.js')>('./transcriptRecorder.js');
  return {
    ...actual,
    currentTranscriptRecorder: () => ({ transcriptId: async () => 'transcript' }),
  };
});

import { runWithActivityNodeTag } from './activityNodeTag.js';
import {
  activityHttpCaptureInterceptor,
  capturingFetch,
  HttpCapture,
  runWithHttpCapture,
  withHttpPurpose,
} from './httpCapture.js';
import {
  recordingFetch,
  runWithTranscriptRecorder,
  type TranscriptRecorder,
} from './transcriptRecorder.js';

beforeEach(() => {
  h.rows.length = 0;
  h.fail = false;
  h.enabled = true;
});
describe('activity HTTP capture', () => {
  it('passes through outside an activity without storing a row', async () => {
    const response = new Response('ok');
    expect(await capturingFetch(vi.fn(async () => response))('https://example.com')).toBe(response);
    expect(h.rows).toEqual([]);
  });
  it('records once through nested wrappers with node and tenant attribution, without headers', async () => {
    const capture = new HttpCapture(8192);
    const fetch = capturingFetch(
      capturingFetch(vi.fn(async () => Response.json({ password: 'secret', value: 'ok' })))
    );
    await runWithActivityNodeTag(
      { recordingId: 'fan[0]/node', specNodeId: 'node', stepAttempt: 3 },
      () =>
        runWithHttpCapture(capture, () =>
          withHttpPurpose('connector', () =>
            fetch('https://example.com/path?token=secret&keep=yes', {
              body: JSON.stringify({ apiKey: 'hidden', value: 'safe' }),
              headers: { authorization: 'Bearer hidden', 'content-type': 'application/json' },
              method: 'POST',
            })
          )
        )
    );
    await capture.close();
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      attempt: 2,
      path: '/path?keep=yes',
      purpose: 'connector',
      recordingId: 'fan[0]/node',
      runId: 'run',
      stepAttempt: 3,
      teamId: 'team',
      temporalRunId: 'temporal',
      workflowId: 'workflow',
    });
    expect(JSON.stringify(h.rows)).not.toContain('hidden');
    expect(JSON.stringify(h.rows)).not.toContain('secret');
    expect(h.rows[0]).not.toHaveProperty('headers');
    expect(h.rows[0].responseBody).toContain('ok');
  });
  it('caps bodies after masking and leaves the caller response intact', async () => {
    const capture = new HttpCapture(8);
    const response = await runWithHttpCapture(capture, () =>
      capturingFetch(
        vi.fn(
          async () => new Response('hello world!', { headers: { 'content-type': 'text/plain' } })
        )
      )('https://example.com')
    );
    expect(await response.text()).toBe('hello world!');
    await capture.close();
    expect(h.rows[0]).toMatchObject({ bodiesTruncated: true, responseBody: 'hello wo' });
  });
  it('redacts PEM keys and JWTs in non-JSON bodies', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    const capture = new HttpCapture(8192);
    await runWithHttpCapture(capture, () =>
      capturingFetch(
        vi.fn(
          async () =>
            new Response(`token ${jwt} and ${pem} done`, {
              headers: { 'content-type': 'text/plain' },
            })
        )
      )('https://example.com')
    );
    await capture.close();
    const stored = String(h.rows[0].responseBody);
    expect(stored).not.toContain('eyJhbGci');
    expect(stored).not.toContain('MIIEvQ');
    expect(stored).toContain('done');
  });
  it('records model metadata only once and links its transcript', async () => {
    const capture = new HttpCapture(8192);
    await runWithHttpCapture(capture, () =>
      capturingFetch(
        capturingFetch(vi.fn(async () => Response.json({ prompt: 'private' }))),
        'model'
      )('https://example.com')
    );
    await capture.close();
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ purpose: 'model', transcriptId: 'transcript' });
    expect(h.rows[0].responseBody).toBeUndefined();
  });

  it.each([undefined, 'embedding'] as const)(
    'integrates recordingFetch (%s) without duplicating calls',
    async (purpose) => {
      const capture = new HttpCapture(8192);
      const captures: Promise<unknown>[] = [];
      const recorder = {
        addHttpCall: vi.fn(),
        trackCapture: (work: Promise<unknown>) => captures.push(work),
      } as unknown as TranscriptRecorder;
      await runWithTranscriptRecorder(recorder, () =>
        runWithHttpCapture(capture, () =>
          recordingFetch(capturingFetch(vi.fn(async () => Response.json({ secret: 'private' }))), {
            purpose,
          })('https://example.com')
        )
      );
      await capture.close();
      await Promise.all(captures);
      expect(h.rows).toHaveLength(1);
      expect(h.rows[0]).toMatchObject({ purpose: purpose ?? 'model', transcriptId: 'transcript' });
      expect(h.rows[0].responseBody).toBeUndefined();
      expect(recorder.addHttpCall).toHaveBeenCalledOnce();
    }
  );
  it('captures transport errors and swallows persistence failures', async () => {
    const capture = new HttpCapture(0);
    await expect(
      runWithHttpCapture(capture, () =>
        capturingFetch(
          vi.fn(async () => {
            throw new Error('offline');
          })
        )('https://example.com')
      )
    ).rejects.toThrow('offline');
    await capture.close();
    expect(h.rows[0].error).toContain('offline');
    h.fail = true;
    const failed = new HttpCapture(0);
    await runWithHttpCapture(failed, () =>
      capturingFetch(vi.fn(async () => new Response('')))('https://example.com')
    );
    await expect(failed.close()).resolves.toBeUndefined();
  });

  it('does not capture when disabled at the activity interceptor', async () => {
    h.enabled = false;
    await activityHttpCaptureInterceptor().inbound?.execute?.(
      { args: [], headers: {} } as never,
      async () => capturingFetch(vi.fn(async () => new Response('ok')))('https://example.com')
    );
    expect(h.rows).toEqual([]);
  });

  it('flushes batches and remaining rows at close', async () => {
    const capture = new HttpCapture(0);
    const fetch = capturingFetch(vi.fn(async () => new Response('')));
    await runWithHttpCapture(capture, () =>
      Promise.all(Array.from({ length: 205 }, () => fetch('https://example.com')))
    );
    await capture.close();
    expect(h.rows).toHaveLength(205);
    expect(new Set(h.rows.map((row) => row.id)).size).toBe(205);
  });

  it('handles empty, binary and disabled bodies without consuming the response', async () => {
    for (const [max, response] of [
      [8192, new Response(null)],
      [
        8192,
        new Response(new Uint8Array([1, 2]), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ],
      [0, Response.json({ token: 'private' })],
    ] as const) {
      const capture = new HttpCapture(max);
      expect(
        await runWithHttpCapture(capture, () =>
          capturingFetch(vi.fn(async () => response))('https://example.com')
        )
      ).toBe(response);
      await capture.close();
    }
    expect(h.rows).toHaveLength(3);
    expect(h.rows.every((row) => row.responseBody === undefined)).toBe(true);
  });

  it('caps multibyte bodies in bytes, not characters', async () => {
    const capture = new HttpCapture(5);
    await runWithHttpCapture(capture, () =>
      capturingFetch(
        vi.fn(async () => new Response('😀😀', { headers: { 'content-type': 'text/plain' } }))
      )('https://example.com')
    );
    await capture.close();
    expect(Buffer.byteLength(String(h.rows[0].responseBody))).toBeLessThanOrEqual(5);
    expect(h.rows[0].bodiesTruncated).toBe(true);
  });

  it('persists metadata for a nonterminating response without delaying the caller', async () => {
    vi.useFakeTimers();
    try {
      const capture = new HttpCapture(8192);
      const response = new Response(new ReadableStream(), {
        headers: { 'content-type': 'text/event-stream' },
      });
      expect(
        await runWithHttpCapture(capture, () =>
          capturingFetch(vi.fn(async () => response))('https://example.com')
        )
      ).toBe(response);
      await vi.advanceTimersByTimeAsync(2000);
      await capture.close();
      expect(h.rows[0]).toMatchObject({ bodiesTruncated: true, status: 200 });
    } finally {
      vi.useRealTimers();
    }
  });
});
