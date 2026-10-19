import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  artifacts: [] as { body: Buffer; contentType: string; kind: string; runId?: string }[],
  createFails: { value: false },
  failureCounter: [] as string[],
  partCreateFails: { value: false },
  parts: [] as {
    artifactId: string;
    recordCount: number;
    seq: number;
    sha256: string;
    transcriptId: string;
  }[],
  run: {
    id: 'run-1',
    transcriptLegalHold: true,
    transcriptLegalHoldAt: new Date('2026-10-19T00:00:00Z'),
    transcriptLegalHoldById: 'user-1',
    transcriptLegalHoldReason: 'litigation',
  } as null | Record<string, unknown>,
  settings: {
    captureEnabled: true,
    maxBytes: 64 * 1024 * 1024,
  },
  transcripts: [] as { data: Record<string, unknown>; id: string }[],
  updateFails: { value: false },
  updates: [] as { data: Record<string, unknown>; where: { id: string } }[],
}));

vi.mock('@temporalio/activity', () => ({
  activityInfo: () => ({
    activityType: 'executeImplementation',
    attempt: 2,
    workflowExecution: { runId: 'temporal-1', workflowId: 'wf-1' },
  }),
  CancelledFailure: class CancelledFailure extends Error {
    constructor(message = 'cancelled') {
      super(message);
      this.name = 'CancelledFailure';
    }
  },
  Context: { current: () => ({}) },
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agentTrace: {
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    agentTranscript: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (h.createFails.value) {
          throw new Error('insert refused');
        }
        const row = { data, id: `tx-${h.transcripts.length + 1}` };
        h.transcripts.push(row);
        return row;
      }),
      update: vi.fn(async (args: { data: Record<string, unknown>; where: { id: string } }) => {
        if (h.updateFails.value) {
          throw new Error('update refused');
        }
        h.updates.push(args);
        return {};
      }),
    },
    agentTranscriptPart: {
      create: vi.fn(async ({ data }: { data: (typeof h.parts)[number] }) => {
        if (h.partCreateFails.value) {
          throw new Error('part insert refused');
        }
        h.parts.push(data);
        return { id: `part-${h.parts.length}` };
      }),
    },
    workflowRun: {
      findUnique: vi.fn(async () => h.run),
    },
  },
}));

vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  putArtifact: vi.fn(
    async (input: { body: Buffer; contentType?: string; kind: string; runId?: string }) => {
      h.artifacts.push({
        body: input.body,
        contentType: input.contentType ?? 'application/octet-stream',
        kind: input.kind,
        runId: input.runId,
      });
      return { id: `art-${h.artifacts.length}` };
    }
  ),
}));

vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) => {
    if (key === 'workflow.transcriptCaptureEnabled') {
      return h.settings.captureEnabled;
    }
    if (key === 'workflow.transcriptMaxBytes') {
      return h.settings.maxBytes;
    }
    throw new Error(`unexpected setting ${key}`);
  }),
}));

vi.mock('./spendOwner.js', () => ({
  currentSpendOwner: async () => ({ orgId: 'org-1', teamId: 'team-1' }),
}));
vi.mock('./runlessBudget.js', () => ({ takePersistingUsage: () => () => {} }));
vi.mock('./activityLog.js', () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock('./metrics.js', () => ({
  recordTranscriptPersistFailure: (stage: string) => h.failureCounter.push(stage),
}));

import { CancelledFailure } from '@temporalio/activity';
import {
  activityTranscriptInterceptor,
  currentTranscriptRecorder,
  recordingFetch,
  runWithTranscriptRecorder,
  TranscriptRecorder,
} from './transcriptRecorder.js';

const record = (overrides: Record<string, unknown> = {}) => ({
  durationMs: 12,
  host: 'api.anthropic.com',
  method: 'POST',
  path: '/v1/messages',
  request: { model: 'claude-x' },
  response: { body: { ok: true }, contentType: 'application/json' },
  status: 200,
  ...overrides,
});

/** Every part's decompressed NDJSON lines, parsed. */
function partLines(): Record<string, unknown>[][] {
  return h.artifacts.map((a) =>
    gunzipSync(a.body)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  );
}

beforeEach(() => {
  h.artifacts.length = 0;
  h.createFails.value = false;
  h.failureCounter.length = 0;
  h.partCreateFails.value = false;
  h.parts.length = 0;
  h.settings.captureEnabled = true;
  h.settings.maxBytes = 64 * 1024 * 1024;
  h.transcripts.length = 0;
  h.updateFails.value = false;
  h.updates.length = 0;
});

describe('TranscriptRecorder', () => {
  it('writes no row when the attempt recorded nothing', async () => {
    await new TranscriptRecorder().close('succeeded');
    expect(h.transcripts).toHaveLength(0);
    expect(h.artifacts).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
  });

  it('waits for a response still streaming when the activity returns', async () => {
    // The caller consumes its response and the attempt ends immediately; the
    // background clone read finishes during close's capture drain.
    const body = JSON.stringify({ done: true });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        controller = c;
      },
    });
    const wrapped = recordingFetch(async () => new Response(stream));
    const r = new TranscriptRecorder();
    const res = await runWithTranscriptRecorder(r, () =>
      wrapped('https://api.anthropic.com/v1/messages', { method: 'POST' })
    );
    const closing = r.close('succeeded');
    await new Promise((resolve) => setImmediate(resolve));
    controller?.close();
    await closing;
    await res.text();

    const calls = partLines()
      .flat()
      .filter((l) => l.kind === 'http_call');
    expect(calls).toHaveLength(1);
  });

  it('creates the row lazily on the first record and completes it at close', async () => {
    const r = new TranscriptRecorder();
    r.addHttpCall(record());
    await r.close('succeeded');

    expect(h.transcripts).toHaveLength(1);
    const row = h.transcripts[0]?.data as Record<string, unknown>;
    expect(row).toMatchObject({
      activityType: 'executeImplementation',
      attempt: 2,
      orgId: 'org-1',
      runId: 'run-1',
      runLegalHold: true,
      runLegalHoldById: 'user-1',
      runLegalHoldReason: 'litigation',
      runtime: 'ai-sdk',
      teamId: 'team-1',
      temporalRunId: 'temporal-1',
      workflowId: 'wf-1',
    });
    expect(h.parts).toHaveLength(1);
    expect(h.parts[0]?.recordCount).toBe(1);
    // The part's payload does not belong to the run — run deletion must not take it.
    expect(h.artifacts[0]?.runId).toBeUndefined();
    expect(h.artifacts[0]?.kind).toBe('agent-transcript-part');
    expect(h.updates[0]?.data).toMatchObject({
      modelCallCount: 1,
      sizeBytes: expect.any(Number),
    });
    expect(h.updates[1]?.data).toMatchObject({
      activityOutcome: 'succeeded',
      modelCallCount: 1,
      runtime: 'ai-sdk',
      status: 'complete',
    });
    expect(h.updates[1]?.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    const lines = partLines()[0] ?? [];
    expect(lines[0]).toMatchObject({
      host: 'api.anthropic.com',
      kind: 'http_call',
      method: 'POST',
      path: '/v1/messages',
      status: 200,
    });
  });

  it('flushes a part once the buffer reaches 8 MiB, before close', async () => {
    const r = new TranscriptRecorder();
    r.addHttpCall(record({ request: { blob: 'x'.repeat(8 * 1024 * 1024) } }));
    await vi.waitFor(() => expect(h.parts.length).toBeGreaterThan(0));
    const before = h.parts.length;
    await r.close('succeeded');
    expect(h.parts.length).toBe(before);
  });

  it('flushes a non-empty buffer on the 30 s timer', async () => {
    vi.useFakeTimers();
    try {
      const r = new TranscriptRecorder();
      r.addHttpCall(record());
      await vi.advanceTimersByTimeAsync(30_000);
      // The gzip + part write is real async work; let it land.
      vi.useRealTimers();
      await vi.waitFor(() => expect(h.parts).toHaveLength(1));
      await r.close('succeeded');
      expect(h.parts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes a truncated marker and stops recording past the byte cap', async () => {
    h.settings.maxBytes = 1;
    const r = new TranscriptRecorder();
    // Big enough to trigger the size flush, so the cap is hit before close.
    r.addHttpCall(record({ request: { blob: 'x'.repeat(8 * 1024 * 1024) } }));
    await vi.waitFor(() => expect(h.parts.length).toBeGreaterThan(0));
    // Let the flush's truncation bookkeeping finish before recording more.
    await new Promise((resolve) => setTimeout(resolve, 20));
    r.addHttpCall(record());
    await r.close('succeeded');

    expect(h.updates.at(-1)?.data.status).toBe('truncated');
    const all = partLines().flat();
    expect(all.some((l) => l.kind === 'marker' && l.event === 'truncated')).toBe(true);
    // The call recorded after the cap was hit went nowhere.
    expect(all.filter((l) => l.kind === 'http_call')).toHaveLength(1);
  });

  it('marks the row incomplete and counts the failure when a part write fails', async () => {
    h.partCreateFails.value = true;
    const r = new TranscriptRecorder();
    r.addHttpCall(record());
    await expect(r.close('succeeded')).resolves.toBeUndefined();

    expect(h.updates.at(-1)?.data.status).toBe('incomplete');
    expect(h.failureCounter).toContain('part');
  });

  it('never throws from close, even when the final update fails', async () => {
    h.updateFails.value = true;
    const r = new TranscriptRecorder();
    r.addHttpCall(record());
    await expect(r.close('failed')).resolves.toBeUndefined();
    expect(h.failureCounter).toContain('close');
  });

  it('redacts secrets without truncating long values', async () => {
    const long = 'y'.repeat(40_000);
    const r = new TranscriptRecorder();
    r.addHttpCall(record({ request: { api_key: 'sk-live-secret', payload: long } }));
    await r.close('succeeded');

    const line = partLines()[0]?.[0] as { request: { api_key: string; payload: string } };
    expect(line.request.api_key).toBe('***');
    expect(line.request.payload).toBe(long);
  });

  it('dedupes the agent keys reported during the attempt onto the row', async () => {
    const r = new TranscriptRecorder();
    r.noteAgentKey('implementer');
    r.noteAgentKey('implementer');
    r.noteAgentKey('reviewer');
    r.addHttpCall(record());
    await r.close('succeeded');

    const keys = h.updates.at(-1)?.data.agentKeys as string[];
    expect([...keys].sort()).toEqual(['implementer', 'reviewer']);
  });

  it('is a no-op when transcript capture is disabled', async () => {
    h.settings.captureEnabled = false;
    const r = new TranscriptRecorder();
    r.addHttpCall(record());
    await r.close('succeeded');

    expect(h.transcripts).toHaveLength(0);
    expect(h.artifacts).toHaveLength(0);
  });
});

describe('recordingFetch', () => {
  const stubRecorder = () => {
    const calls: Record<string, unknown>[] = [];
    return {
      calls,
      recorder: {
        addHttpCall: (c: Record<string, unknown>) => calls.push(c),
        trackCapture: (p: Promise<void>) => void p,
      } as never,
    };
  };

  it('passes straight through when no recorder is active', async () => {
    const inner = vi.fn(async () => new Response('{}'));
    const res = await recordingFetch(inner as never as typeof fetch)('https://x/y', {});
    expect(await res.text()).toBe('{}');
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('returns the response unchanged while the clone is recorded', async () => {
    const { calls, recorder } = stubRecorder();
    const body = JSON.stringify({ answer: 42 });
    const wrapped = recordingFetch(
      async () => new Response(body, { headers: { 'content-type': 'application/json' } })
    );
    const res = await runWithTranscriptRecorder(recorder, () =>
      wrapped('https://api.openai.com/v1/responses', {
        body: JSON.stringify({ input: 'hi', model: 'gpt-x' }),
        method: 'POST',
      })
    );
    expect(await res.text()).toBe(body);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      host: 'api.openai.com',
      method: 'POST',
      path: '/v1/responses',
      request: { input: 'hi', model: 'gpt-x' },
      response: { body: { answer: 42 } },
      status: 200,
    });
  });

  it('records an SSE body as raw text', async () => {
    const { calls, recorder } = stubRecorder();
    const sse = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    const wrapped = recordingFetch(
      async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    );
    const res = await runWithTranscriptRecorder(recorder, () =>
      wrapped('https://api.anthropic.com/v1/messages', { method: 'POST' })
    );
    await res.text();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const recorded = calls[0]?.response as { body: string };
    expect(recorded.body).toBe(sse);
  });

  it('records the error when the response body aborts mid-read', async () => {
    const { calls, recorder } = stubRecorder();
    const wrapped = recordingFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('partial'));
              c.error(new Error('socket hangup'));
            },
          })
        )
    );
    const res = await runWithTranscriptRecorder(recorder, () =>
      wrapped('https://api.anthropic.com/v1/messages', { method: 'POST' })
    );
    // The caller still got its Response — the failure is only on the clone.
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.error).toMatch(/hangup/);
  });

  it('records the error when fetch itself throws', async () => {
    const { calls, recorder } = stubRecorder();
    const wrapped = recordingFetch(async () => {
      throw new Error('net down');
    });
    await expect(
      runWithTranscriptRecorder(recorder, () =>
        wrapped('https://api.anthropic.com/v1/messages', { method: 'POST' })
      )
    ).rejects.toThrow('net down');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ error: 'net down' });
    expect(calls[0]).not.toHaveProperty('status');
  });

  it("strips Google's key= credential from the recorded query, keeping other params", async () => {
    const { calls, recorder } = stubRecorder();
    const wrapped = recordingFetch(async () => new Response('{}'));
    await runWithTranscriptRecorder(recorder, () =>
      wrapped('https://generativelanguage.googleapis.com/v1/m:generate?key=AIzaSECRET&alt=sse', {
        method: 'POST',
      })
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe('/v1/m:generate?alt=sse');
    expect(JSON.stringify(calls[0])).not.toContain('AIzaSECRET');
  });

  it('records no headers', async () => {
    const { calls, recorder } = stubRecorder();
    const wrapped = recordingFetch(async () => new Response('{}'));
    await runWithTranscriptRecorder(recorder, () =>
      wrapped('https://api.anthropic.com/v1/messages', {
        headers: { 'x-api-key': 'sk-secret' },
        method: 'POST',
      })
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).not.toHaveProperty('headers');
    expect(JSON.stringify(calls[0])).not.toContain('sk-secret');
  });
});

describe('activityTranscriptInterceptor', () => {
  const execute = () =>
    (
      activityTranscriptInterceptor() as unknown as {
        inbound: { execute: (input: never, next: () => Promise<unknown>) => Promise<unknown> };
      }
    ).inbound.execute;

  const input = { args: [], headers: {} } as never;

  it('closes the recorder with succeeded when the activity succeeds', async () => {
    const result = await execute()(input, async () => {
      currentTranscriptRecorder()?.addHttpCall(record());
      return 'done';
    });
    expect(result).toBe('done');
    await vi.waitFor(() => expect(h.updates.length).toBeGreaterThan(0));
    expect(h.updates.at(-1)?.data.activityOutcome).toBe('succeeded');
  });

  it('closes with failed and lets the activity error propagate unchanged', async () => {
    const failure = new Error('activity blew up');
    await expect(
      execute()(input, async () => {
        currentTranscriptRecorder()?.addHttpCall(record());
        throw failure;
      })
    ).rejects.toBe(failure);
    await vi.waitFor(() => expect(h.updates.length).toBeGreaterThan(0));
    expect(h.updates.at(-1)?.data.activityOutcome).toBe('failed');
  });

  it('closes with cancelled on a Temporal cancellation', async () => {
    await expect(
      execute()(input, async () => {
        throw new CancelledFailure('stop requested');
      })
    ).rejects.toThrow(CancelledFailure);
    // The attempt wrote nothing, so no row exists — close is a no-op, not an error.
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      execute()(input, async () => {
        currentTranscriptRecorder()?.addHttpCall(record());
        throw new CancelledFailure('stop requested');
      })
    ).rejects.toThrow(CancelledFailure);
    await vi.waitFor(() => expect(h.updates.length).toBeGreaterThan(0));
    expect(h.updates.at(-1)?.data.activityOutcome).toBe('cancelled');
  });
});

describe('close bound', () => {
  it('returns the activity result within 30 s when persistence hangs', async () => {
    vi.useFakeTimers();
    try {
      const { putArtifact } = await import('@auto-swe/shared/lib/artifactStore');
      vi.mocked(putArtifact).mockImplementationOnce(() => new Promise(() => {}));
      const execute = (
        activityTranscriptInterceptor() as unknown as {
          inbound: { execute: (input: never, next: () => Promise<unknown>) => Promise<unknown> };
        }
      ).inbound.execute;
      const done = execute({ args: [], headers: {} } as never, async () => {
        currentTranscriptRecorder()?.addHttpCall(record());
        return 'activity-result';
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(done).resolves.toBe('activity-result');
      expect(h.failureCounter).toContain('close');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('record bounds', () => {
  it('truncates an over-limit response body and writes a record_truncated marker', async () => {
    const r = new TranscriptRecorder();
    const huge = 'x'.repeat(20 * 1024 * 1024);
    r.addHttpCall(record({ response: { body: huge, contentType: 'text/plain' } }));
    await r.close('succeeded');
    const lines = partLines().flat();
    const call = lines.find((l) => l.kind === 'http_call') as
      | { response?: { body: { truncated?: boolean; originalBytes?: number; head?: string } } }
      | undefined;
    expect(call?.response?.body.truncated).toBe(true);
    expect(call?.response?.body.head).toHaveLength(1024 * 1024);
    expect(call?.response?.body.originalBytes).toBe(20 * 1024 * 1024);
    expect(lines.some((l) => l.kind === 'marker' && l.event === 'record_truncated')).toBe(true);
  });

  it('turns a proxy-capped responseText into the truncated shape', async () => {
    const r = new TranscriptRecorder();
    r.addHttpCall(
      record({
        response: { body: 'partial-body', contentType: null },
        responseTruncated: true,
      })
    );
    await r.close('succeeded');
    const call = partLines()
      .flat()
      .find((l) => l.kind === 'http_call') as
      | { response?: { body: { truncated?: boolean } } }
      | undefined;
    expect(call?.response?.body.truncated).toBe(true);
  });
});

describe('record ordering', () => {
  it('keeps seqs consecutive and unique across an oversized record, marker after it', async () => {
    const r = new TranscriptRecorder();
    r.addHttpCall(record());
    r.addHttpCall(
      record({ response: { body: 'x'.repeat(20 * 1024 * 1024), contentType: 'text/plain' } })
    );
    r.addHttpCall(record());
    await r.close('succeeded');
    const lines = partLines().flat();
    const seqs = lines.map((l) => l.seq as number);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    const truncated = lines.findIndex(
      (l) =>
        l.kind === 'http_call' &&
        (l.response as { body?: { truncated?: boolean } })?.body?.truncated === true
    );
    expect(lines[truncated + 1]?.kind).toBe('marker');
    expect((lines[truncated + 1] as { event?: string }).event).toBe('record_truncated');
  });
});

describe('timers', () => {
  it('leaves no timers behind after close', async () => {
    vi.useFakeTimers();
    try {
      const r = new TranscriptRecorder();
      r.addHttpCall(record());
      await r.close('succeeded');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('recordingFetch capture cap', () => {
  it('caps a streaming response capture and marks it truncated', async () => {
    const calls: Record<string, unknown>[] = [];
    const recorder = {
      addHttpCall: (c: Record<string, unknown>) => calls.push(c),
      trackCapture: (p: Promise<void>) => void p,
    } as never;
    const chunk = new Uint8Array(1024).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 64; i++) {
          c.enqueue(chunk);
        }
        c.close();
      },
    });
    const wrapped = recordingFetch(async () => new Response(stream), {
      maxRecordBytes: 4096,
    });
    const res = await runWithTranscriptRecorder(recorder, () =>
      wrapped('https://api.anthropic.com/v1/messages', { method: 'POST' })
    );
    await res.text();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.responseTruncated).toBe(true);
  });
});

describe('recordingFetch Request input', () => {
  it('captures the body of a Request input when init carries none', async () => {
    const calls: Record<string, unknown>[] = [];
    const recorder = {
      addHttpCall: (c: Record<string, unknown>) => calls.push(c),
      trackCapture: (p: Promise<void>) => void p,
    } as never;
    const inner = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          headers: { 'content-type': 'application/json' },
        })
    );
    const wrapped = recordingFetch(inner as never as typeof fetch);
    const res = await runWithTranscriptRecorder(recorder, () =>
      wrapped(
        new Request('https://api.anthropic.com/v1/messages', {
          body: '{"prompt":"hi"}',
          method: 'POST',
        })
      )
    );
    await res.text();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.request).toEqual({ prompt: 'hi' });
    expect(calls[0]?.method).toBe('POST');
  });
});
