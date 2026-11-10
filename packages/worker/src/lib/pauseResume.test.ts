import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./activityContext.js', () => ({ currentWorkflowRunId: vi.fn(async () => 'run-1') }));
vi.mock('./pauseSnapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pauseSnapshot.js')>()),
  restoreWorkingTree: vi.fn(async () => {}),
  snapshotWorkingTree: vi.fn(),
}));

import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';
import { AgentTracer } from './agentTracer.js';
import {
  checkSurfaceState,
  cloneCredentialSecrets,
  pausable,
  pauseForInput,
  readResumeInput,
  readSurfaceState,
  restoreForResume,
  resumeCheckoutSha,
  resumeMessage,
} from './pauseResume.js';
import { QUESTIONS, resumeInputFor } from './pauseResumeFixtures.js';
import { restoreWorkingTree, snapshotWorkingTree } from './pauseSnapshot.js';

const expectTo = { agentKey: 'a', branch: 'b', kind: 'runAgentNode' as const };
const good = { agentKey: 'a', branch: 'b', kind: 'runAgentNode' };

beforeEach(() => vi.clearAllMocks());

describe('pausable', () => {
  it('turns pausing on only for a run that may pause on Claude Code', () => {
    expect(pausable(true, 'claude-code')).toEqual({ allowPause: true });
    expect(pausable(true, 'pi')).toEqual({});
    expect(pausable(true, 'mastra')).toEqual({});
    expect(pausable(false, 'claude-code')).toEqual({});
    expect(pausable(undefined, 'claude-code')).toEqual({});
  });
});

describe('resumeCheckoutSha', () => {
  it('is the commit the saved tree is a patch against', () => {
    expect(resumeCheckoutSha(resumeInputFor(good))).toBe('a'.repeat(40));
  });

  it('is nothing for a first run and for a clean tree, which start from the branch tip', () => {
    expect(resumeCheckoutSha(undefined)).toBeUndefined();
    expect(resumeCheckoutSha(resumeInputFor(good, { snapshot: null }))).toBeUndefined();
  });
});

describe('cloneCredentialSecrets', () => {
  it('names the token, the auth header and its base64 part, and nothing for a bare URL', () => {
    const secrets = cloneCredentialSecrets('https://x-access-token:tok%2Fen@github.com/o/r.git');
    const b64 = Buffer.from('x-access-token:tok/en').toString('base64');
    expect(secrets).toEqual(['tok/en', `AUTHORIZATION: basic ${b64}`, b64]);
    expect(cloneCredentialSecrets('https://github.com/o/r.git')).toEqual([]);
    expect(cloneCredentialSecrets('not a url')).toEqual([]);
  });
});

describe('readResumeInput', () => {
  it('accepts a valid input', () => {
    expect(readResumeInput(resumeInputFor(good)).round).toBe(2);
  });

  it.each([
    [
      'a wrong version',
      { ...resumeInputFor(good), resume: { ...resumeInputFor(good).resume, version: 2 } },
    ],
    ['no answers field', { resume: resumeInputFor(good).resume, round: 1 }],
    ['an extra field', { ...resumeInputFor(good), extra: true }],
    ['nothing', undefined],
  ])('refuses %s, non-retryably', (_name, raw) => {
    expect(() => readResumeInput(raw)).toThrowError(
      expect.objectContaining({ nonRetryable: true, type: 'NEEDS_INPUT_RESTORE_FAILED' })
    );
  });
});

describe('surface state', () => {
  it('accepts the state its own surface wrote', () => {
    expect(() => checkSurfaceState(resumeInputFor(good).resume, expectTo)).not.toThrow();
  });

  it.each([
    ['surface', { ...good, kind: 'runAgentTask' }],
    ['agent', { ...good, agentKey: 'x' }],
    ['branch', { ...good, branch: 'x' }],
    ['shape', { kind: 'runAgentNode' }],
    ['absence', undefined],
  ])('refuses a state with the wrong %s', (_name, state) => {
    expect(() => checkSurfaceState(resumeInputFor(state).resume, expectTo)).toThrowError(
      expect.objectContaining({ nonRetryable: true, type: 'NEEDS_INPUT_RESTORE_FAILED' })
    );
  });

  it('reads the extra fields a surface needs, and refuses a state without them', () => {
    const extra = z.object({ iteration: z.number() });
    expect(
      readSurfaceState(resumeInputFor({ ...good, iteration: 3 }).resume, expectTo, extra)
    ).toMatchObject({
      iteration: 3,
    });
    expect(() => readSurfaceState(resumeInputFor(good).resume, expectTo, extra)).toThrowError(
      expect.objectContaining({ type: 'NEEDS_INPUT_RESTORE_FAILED' })
    );
  });
});

describe('pauseForInput', () => {
  const snapshot = {
    artifactId: 'art-1',
    baseSha: 'a'.repeat(40),
    bytes: 5,
    sha256: 'b'.repeat(64),
  };
  const workspace = (names = 'src/a.ts\nsrc/b.ts\n') =>
    ({ exec: vi.fn(async () => names) }) as unknown as Workspace;

  it('names the files the snapshot staged in the digest and the surface in the state', async () => {
    vi.mocked(snapshotWorkingTree).mockResolvedValue({ snapshot });
    const result = await pauseForInput({
      lastText: 'which db?',
      questions: QUESTIONS,
      startSha: 'a'.repeat(40),
      state: { agentKey: 'a', branch: 'b', iteration: 2 },
      surface: 'executeImplementation',
      tracer: new AgentTracer(),
      workspace: workspace(),
    });
    expect(result.needsInput.resume).toMatchObject({
      asked: [{ header: 'DB', question: 'Which database?' }],
      snapshot,
      surface: { agentKey: 'a', branch: 'b', iteration: 2, kind: 'executeImplementation' },
      version: 1,
    });
    expect(result.needsInput.resume.digest).toContain('src/a.ts, src/b.ts');
    expect(result.needsInput.resume.digest).toContain('which db?');
    // Saved against the commit the checkout started at, and the files named against it too.
    expect(snapshotWorkingTree).toHaveBeenCalledWith(expect.anything(), {
      runId: 'run-1',
      startSha: 'a'.repeat(40),
    });
  });

  it('masks the clone credential it is given by value in the digest', async () => {
    vi.mocked(snapshotWorkingTree).mockResolvedValue({ snapshot: null });
    const url = 'https://x-access-token:hunter2hunter2@github.com/o/r.git';
    const result = await pauseForInput({
      lastText: 'I used hunter2hunter2 to log in',
      questions: QUESTIONS,
      secrets: cloneCredentialSecrets(url),
      startSha: 'a'.repeat(40),
      state: { agentKey: 'a', branch: 'b' },
      surface: 'runAgentNode',
      tracer: new AgentTracer(),
      workspace: workspace(),
    });
    expect(result.needsInput.resume.digest).not.toContain('hunter2hunter2');
  });

  it('saves a clean tree as no snapshot and names no files', async () => {
    vi.mocked(snapshotWorkingTree).mockResolvedValue({ snapshot: null });
    const ws = workspace();
    const result = await pauseForInput({
      questions: QUESTIONS,
      startSha: 'a'.repeat(40),
      state: { agentKey: 'a', branch: 'b' },
      surface: 'runAgentNode',
      tracer: new AgentTracer(),
      workspace: ws,
    });
    expect(result.needsInput.resume.snapshot).toBeNull();
    expect(ws.exec).not.toHaveBeenCalled();
  });

  it('refuses, non-retryably, state too large for a person to be handed', async () => {
    vi.mocked(snapshotWorkingTree).mockResolvedValue({ snapshot: null });
    await expect(
      pauseForInput({
        questions: QUESTIONS,
        startSha: 'a'.repeat(40),
        state: { agentKey: 'a', blob: 'x'.repeat(20_000), branch: 'b' },
        surface: 'runAgentNode',
        tracer: new AgentTracer(),
        workspace: workspace(),
      })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'NEEDS_INPUT_TOO_LARGE' });
  });
});

describe('restoreForResume and resumeMessage', () => {
  it('restores the saved tree and reports only counts', async () => {
    const tracer = new AgentTracer();
    const events = vi.spyOn(tracer, 'addActivityEvent');
    const resume = resumeInputFor(good);
    await restoreForResume({ resume, surface: 'runAgentNode', tracer, workspace: {} as Workspace });
    expect(restoreWorkingTree).toHaveBeenCalledWith({}, resume.resume.snapshot);
    expect(events).toHaveBeenCalledWith({
      name: 'agent.resumed',
      outputJson: { round: 2, snapshotBytes: 10, surface: 'runAgentNode' },
    });
  });

  it('delimits the answers after the task', () => {
    const message = resumeMessage(resumeInputFor(good), 'the task');
    expect(message.startsWith('the task\n')).toBe(true);
    expect(message).toContain(
      '[answers: begin]\nQuestion 1 [DB]:\n| Which database?\nAnswer:\n| Postgres'
    );
  });
});
