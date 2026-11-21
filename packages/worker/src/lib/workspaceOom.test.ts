import { describe, expect, it } from 'vitest';
import {
  describeWorkspaceOom,
  withWorkspaceOomNote,
  withWorkspaceOomNoteOnError,
} from './workspaceOom.js';

describe('describeWorkspaceOom', () => {
  it('names the limit and both knobs for exit 137', () => {
    const note = describeWorkspaceOom({ exitCode: 137 }, '4g');
    expect(note?.startsWith('[auto-swe] ')).toBe(true);
    expect(note).toContain('exit 137');
    expect(note).toContain('most likely');
    expect(note).toContain('limit 4g');
    expect(note).toContain('workspace.memory');
    expect(note).toContain('WORKSPACE_MEMORY');
  });

  it('omits the limit when it is unknown instead of guessing one', () => {
    const note = describeWorkspaceOom({ exitCode: 137 });
    expect(note).not.toBeNull();
    expect(note).not.toContain('(limit');
  });

  it.each([0, 1, 2, 124, 127, 130, 139, 143, 255])('is silent for exit %i', (exitCode) => {
    expect(describeWorkspaceOom({ exitCode }, '4g')).toBeNull();
  });

  it('is silent when the local client reported a signal (timeout, spawn failure)', () => {
    expect(describeWorkspaceOom({ exitCode: 137, signal: 'SIGKILL' }, '4g')).toBeNull();
  });
});

describe('withWorkspaceOomNote', () => {
  it('appends to stderr when it has content and to stdout when it is empty', () => {
    expect(
      withWorkspaceOomNote({ exitCode: 137, stderr: 'Killed', stdout: 'out' }, '4g')
    ).toMatchObject({
      stderr: expect.stringMatching(/^Killed\n.*limit 4g/s),
      stdout: 'out',
    });
    expect(withWorkspaceOomNote({ exitCode: 137, stderr: ' ', stdout: 'out' }, '4g')).toMatchObject(
      {
        stderr: ' ',
        stdout: expect.stringMatching(/^out\n.*limit 4g/s),
      }
    );
  });

  it('returns any other result untouched', () => {
    const result = { exitCode: 1, stderr: 'boom', stdout: '' };
    expect(withWorkspaceOomNote(result, '4g')).toBe(result);
  });
});

describe('withWorkspaceOomNoteOnError', () => {
  it('appends the note after the message for a coded 137 and keeps the other fields', () => {
    const error = Object.assign(new Error('Command failed: x'), { code: 137, stderr: 's' });
    const out = withWorkspaceOomNoteOnError(error, '4g');
    expect(out).toBe(error);
    expect(out.message).toMatch(/^Command failed: x\n.*limit 4g/s);
    expect(out.stderr).toBe('s');
  });

  it.each<[string, number, Record<string, unknown>]>([
    ['another exit code', 1, {}],
    ['a killed client', 137, { killed: true, signal: 'SIGTERM' }],
    ['a signalled client', 137, { signal: 'SIGKILL' }],
  ])('leaves %s alone', (_name, code, extra) => {
    const error = Object.assign(new Error('m'), { code }, extra);
    expect(withWorkspaceOomNoteOnError(error, '4g').message).toBe('m');
  });

  it('passes a non-Error through', () => {
    expect(withWorkspaceOomNoteOnError('x')).toBe('x');
  });
});
