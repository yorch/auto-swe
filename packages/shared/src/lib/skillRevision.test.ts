import { describe, expect, it } from 'vitest';
import {
  initialRevision,
  isRevisionConflict,
  nextRevision,
  skillContentChanged,
  skillContentHash,
} from './skillRevision.js';

const content = { description: 'd', promptText: 'text' };

describe('skillContentHash / skillContentChanged', () => {
  it('is stable for equal content and differs for either field', () => {
    expect(skillContentHash(content)).toBe(skillContentHash({ ...content }));
    expect(skillContentChanged(content, { ...content })).toBe(false);
    expect(skillContentChanged(content, { ...content, promptText: 'other' })).toBe(true);
    expect(skillContentChanged(content, { ...content, description: 'other' })).toBe(true);
  });

  it('does not confuse a field boundary shift for equal content', () => {
    expect(
      skillContentChanged(
        { description: 'bc', promptText: 'a' },
        { description: 'c', promptText: 'ab' }
      )
    ).toBe(true);
  });

  it('treats a null and an absent description as the same', () => {
    expect(
      skillContentChanged(
        { description: null, promptText: 'p' },
        { description: null, promptText: 'p' }
      )
    ).toBe(false);
  });
});

describe('initialRevision', () => {
  it('names revision 1 and carries it as a nested create with its hash and provenance', () => {
    const frag = initialRevision(content, {
      createdById: 'u1',
      scanWarnings: ['w'],
      sourceSha: 'abc',
    });
    expect(frag.currentRevision).toBe(1);
    expect(frag.revisions).toEqual({
      create: expect.objectContaining({
        contentHash: skillContentHash(content),
        createdBy: { connect: { id: 'u1' } },
        revision: 1,
        scanWarnings: ['w'],
        sourceSha: 'abc',
      }),
    });
  });

  it('connects no author for a system write', () => {
    const frag = initialRevision(content);
    expect(
      (frag.revisions as { create: { createdBy?: unknown } }).create.createdBy
    ).toBeUndefined();
  });
});

describe('nextRevision', () => {
  it('bumps the revision and guards the update on the one the caller read', () => {
    const { data, where } = nextRevision({ currentRevision: 4, id: 's1' }, content);
    expect(where).toEqual({ currentRevision: 4, id: 's1' });
    expect(data).toMatchObject({ currentRevision: 5, description: 'd', promptText: 'text' });
    expect(data.revisions).toEqual({ create: expect.objectContaining({ revision: 5 }) });
  });
});

describe('isRevisionConflict', () => {
  it('recognises a lost guard (P2025) and a duplicate index entry (P2002) only', () => {
    expect(isRevisionConflict({ code: 'P2025' })).toBe(true);
    expect(isRevisionConflict({ code: 'P2002' })).toBe(true);
    expect(isRevisionConflict({ code: 'P1001' })).toBe(false);
    expect(isRevisionConflict(new Error('x'))).toBe(false);
    expect(isRevisionConflict(null)).toBe(false);
  });
});
