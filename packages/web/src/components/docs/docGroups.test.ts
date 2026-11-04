import { describe, expect, it } from 'vitest';
import { groupDocs } from './docGroups';

const doc = (slug: string) => ({ slug });

describe('groupDocs', () => {
  it('puts known docs under their audience, in reading order, and drops empty groups', () => {
    const groups = groupDocs([doc('deployment'), doc('quickstart'), doc('agents')]);
    expect(groups.map((g) => g.title)).toEqual([
      'Getting started',
      'Using the platform',
      'Administration',
    ]);
    expect(groups[0].docs.map((d) => d.slug)).toEqual(['quickstart']);
  });

  it('keeps a doc it does not know in Reference, so a new doc still appears', () => {
    const groups = groupDocs([doc('brand-new-doc')]);
    expect(groups).toEqual([{ docs: [doc('brand-new-doc')], id: 'reference', title: 'Reference' }]);
  });

  it('keeps the input order within a group', () => {
    const groups = groupDocs([doc('transcripts'), doc('memory')]);
    expect(groups[0].docs.map((d) => d.slug)).toEqual(['transcripts', 'memory']);
  });
});
