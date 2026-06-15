import { describe, expect, it } from 'vitest';
import { validateInputPayload } from './inputSchema.js';
import {
  getByPath,
  mapEventToRunInput,
  SWE_TRIGGER_MAPPINGS,
  type TriggerMapping,
} from './triggerMapping.js';

describe('getByPath', () => {
  it('reads nested paths', () => {
    expect(getByPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  });
  it('returns undefined on a missing hop without throwing', () => {
    expect(getByPath({ a: {} }, 'a.b.c')).toBeUndefined();
    expect(getByPath(null, 'a')).toBeUndefined();
  });
});

describe('mapEventToRunInput', () => {
  it('maps a GitHub issues.labeled payload via the seed mapping', () => {
    const mapping = SWE_TRIGGER_MAPPINGS.find((m) => m.source === 'github');
    expect(mapping).toBeDefined();
    const event = {
      action: 'labeled',
      issue: { number: 1234, title: 'Add a health endpoint' },
      repository: { full_name: 'acme/payments-api' },
    };
    const payload = mapEventToRunInput(mapping as TriggerMapping, event);
    expect(payload).toEqual({
      budget: 'STANDARD',
      description: 'Add a health endpoint',
      repoFullName: 'acme/payments-api',
      ticketId: '1234', // toString transform
    });
  });

  it('maps a Jira webhook payload via the seed mapping', () => {
    const mapping = SWE_TRIGGER_MAPPINGS.find((m) => m.source === 'jira');
    const event = { issue: { fields: { summary: 'Fix the thing' }, key: 'PROJ-42' } };
    const payload = mapEventToRunInput(mapping as TriggerMapping, event);
    expect(payload).toEqual({
      budget: 'STANDARD',
      description: 'Fix the thing',
      ticketId: 'PROJ-42',
    });
  });

  it('omits fields whose source path is missing (so inputSchema reports them)', () => {
    const mapping = SWE_TRIGGER_MAPPINGS.find((m) => m.source === 'github') as TriggerMapping;
    const payload = mapEventToRunInput(mapping, { issue: { number: 9 }, repository: {} });
    // title + full_name absent → omitted; ticketId + budget present
    expect(payload).toEqual({ budget: 'STANDARD', ticketId: '9' });
  });

  it('applies beforeSlash / afterSlash transforms', () => {
    const mapping: TriggerMapping = {
      fields: [
        { from: 'repository.full_name', to: 'org', transform: 'beforeSlash' },
        { from: 'repository.full_name', to: 'repo', transform: 'afterSlash' },
      ],
      source: 'github',
      templateName: 't',
    };
    expect(mapEventToRunInput(mapping, { repository: { full_name: 'acme/payments-api' } })).toEqual(
      {
        org: 'acme',
        repo: 'payments-api',
      }
    );
  });

  it('lets a non-SWE schedule trigger fire its own template with constant inputs', () => {
    // A schedule fire carries no domain event — constants supply the payload.
    const mapping: TriggerMapping = {
      fields: [
        { const: 'weekly-digest', to: 'job' },
        { const: 7, to: 'days' },
      ],
      source: 'schedule',
      templateName: 'analytics-digest',
    };
    const payload = mapEventToRunInput(mapping, { firedAt: '2026-06-15T03:00:00Z' });
    expect(payload).toEqual({ days: 7, job: 'weekly-digest' });

    // …and that payload validates against the non-SWE template's own inputSchema.
    const schema = {
      properties: { days: { type: 'number' as const }, job: { type: 'string' as const } },
      required: ['job'],
      type: 'object' as const,
    };
    expect(validateInputPayload(schema, payload)).toEqual({ ok: true });
  });

  it('produces a payload that satisfies the SWE inputSchema once a connection is resolved', () => {
    const mapping = SWE_TRIGGER_MAPPINGS.find((m) => m.source === 'github') as TriggerMapping;
    const event = {
      issue: { number: 1234, title: 'Add a health endpoint' },
      repository: { full_name: 'acme/payments-api' },
    };
    const payload = mapEventToRunInput(mapping, event);
    // The receiver resolves repoFullName → a git_repo Connection id before validation.
    const resolved = { ...payload, connectionId: '2c2cfa23-f253-4c05-a21d-e16dda27b552' };
    const schema = {
      properties: {
        budget: { enum: ['STANDARD', 'LARGE', 'EPIC'], type: 'string' as const },
        connectionId: { format: 'uuid' as const, type: 'string' as const },
        description: { type: 'string' as const },
        ticketId: { type: 'string' as const },
      },
      required: ['ticketId', 'connectionId', 'description'],
      type: 'object' as const,
    };
    expect(validateInputPayload(schema, resolved)).toEqual({ ok: true });
  });
});
