import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SAMPLE_PROMPT,
  EPIC_SAMPLE,
  pickSampleField,
  sampleEpicTicketId,
  WORKFLOW_SAMPLE,
} from './sampleTasks';

const schema = (properties: InputSchema['properties']): InputSchema => ({
  properties,
  type: 'object',
});

describe('pickSampleField', () => {
  it('returns null without a schema or without a plain string', () => {
    expect(pickSampleField(null)).toBeNull();
    expect(pickSampleField(schema({}))).toBeNull();
    expect(
      pickSampleField(
        schema({
          count: { type: 'number' },
          flag: { type: 'boolean' },
          id: { format: 'uuid', type: 'string' },
          kind: { enum: ['a', 'b'], type: 'string' },
          repo: { type: 'connection' },
          withDefault: { default: 'x', type: 'string' },
        })
      )
    ).toBeNull();
  });

  it('prefers a task-named string among several', () => {
    expect(
      pickSampleField(schema({ branch: { type: 'string' }, description: { type: 'string' } }))
    ).toBe('description');
  });

  it('takes a lone plain string whatever it is called', () => {
    expect(pickSampleField(schema({ notes: { type: 'string' } }))).toBe('notes');
  });

  it('refuses to guess between several unrelated strings', () => {
    expect(pickSampleField(schema({ branch: { type: 'string' }, title: { type: 'string' } }))).toBe(
      null
    );
  });
});

describe('sampleEpicTicketId', () => {
  it('is unique per fill so a second sample launch does not collide with the first epic', () => {
    const ids = new Set(Array.from({ length: 50 }, () => sampleEpicTicketId()));
    expect(ids.size).toBeGreaterThan(45);
    for (const id of ids) {
      expect(id).toMatch(/^DOCS-SAMPLE-[0-9A-Z]{6}$/);
    }
  });

  it('is deterministic for a given random source and keeps the suffix at six characters', () => {
    expect(sampleEpicTicketId(() => 0)).toBe('DOCS-SAMPLE-000000');
    expect(sampleEpicTicketId(() => 0.999999999)).toMatch(/^DOCS-SAMPLE-[0-9A-Z]{6}$/);
  });
});

describe('sample text', () => {
  it('asks the agent not to change files and promises no outcome', () => {
    expect(AGENT_SAMPLE_PROMPT).toMatch(/Do not change any files/);
    for (const text of [AGENT_SAMPLE_PROMPT, EPIC_SAMPLE.description, WORKFLOW_SAMPLE.text]) {
      expect(text).not.toMatch(/merge|pull request|deploy|delete/i);
    }
  });
});
