import { describe, expect, it } from 'vitest';
import { INCIDENT_TRIAGE_INPUT_SCHEMA as schema } from '../workflow/templates/incidentTriage.js';
import {
  EVENT_ENDPOINT_PRESETS,
  type EventEndpointConfig,
  extractInboundEvent,
} from './inboundEvent.js';
import { buildAutomationPayload } from './inputs.js';
import { sha256Hex } from './sha256.js';
import {
  InboundEventFiltersSchema,
  inboundEventFacts,
  inboundEventSource,
} from './sources/inboundEvent.js';

/**
 * The PagerDuty recipe in docs/inbound-events.md §7, end to end and offline: a v3 webhook body
 * through the `pagerduty-v3` preset's pointers, the recipe's filters, and the shipped input schema.
 * The fixture is MODELLED ON PagerDuty's documented v3 payload, not recorded from a delivery.
 */
const ENDPOINT = '11111111-1111-4111-8111-111111111111';
const REPO = '00000000-0000-4000-8000-000000000000';
const PD_CONNECTION = '22222222-2222-4222-8222-222222222222';
const SERVICE = 'PF9KMXH';

const preset = EVENT_ENDPOINT_PRESETS.find((p) => p.key === 'pagerduty-v3')
  ?.config as EventEndpointConfig;

function body(over: { type?: string; incident?: string; service?: string } = {}) {
  return {
    event: {
      agent: { id: 'PLH1HKV', type: 'user_reference' },
      data: {
        html_url: 'https://acme.pagerduty.com/incidents/Q2ZH7Y2SD3X0RE',
        id: over.incident ?? 'Q2ZH7Y2SD3X0RE',
        service: { id: over.service ?? SERVICE, type: 'service_reference' },
        status: 'triggered',
        title: 'Checkout error rate above 5%',
        type: 'incident',
      },
      event_type: over.type ?? 'incident.triggered',
      id: '01DEN1HNLBC1VITYI8K5EYPZ2M',
      occurred_at: '2026-11-12T13:45:00.000Z',
      resource_type: 'incident',
    },
  };
}

const filters = InboundEventFiltersSchema.parse({
  endpointId: ENDPOINT,
  eventTypes: ['incident.triggered'],
  fields: { incidentId: '/event/data/id' },
  match: [{ op: 'eq', pointer: '/event/data/service/id', value: SERVICE }],
});

const OPTIONS = { mode: 'triage', pagerdutyConnectionId: PD_CONNECTION };

function extract(document: unknown) {
  const got = extractInboundEvent({
    bodyDigest: 'abc123',
    document,
    endpointId: ENDPOINT,
    hash: sha256Hex,
    pointers: preset,
  });
  if (!got.ok) {
    throw new Error(got.message);
  }
  return got.event;
}

function build(document: unknown) {
  const facts = inboundEventFacts(extract(document), filters);
  return { built: buildAutomationPayload(inboundEventSource, schema, OPTIONS, REPO, facts), facts };
}

describe('the pagerduty-v3 preset', () => {
  it('is an hmac-sha256 hex digest in X-PagerDuty-Signature after v1=', () => {
    expect(preset).toMatchObject({
      scheme: 'hmac-sha256',
      signatureEncoding: 'hex',
      signatureHeader: 'X-PagerDuty-Signature',
      signaturePrefix: 'v1=',
    });
  });

  it('reads the type and id from the event, the subject from the incident and the scope from its service', () => {
    const event = extract(body());
    expect(event.type).toBe('incident.triggered');
    expect(event.id).toBe('01DEN1HNLBC1VITYI8K5EYPZ2M');
    expect(event.subject).toBe('Q2ZH7Y2SD3X0RE');
    expect(event.scope).toBe(SERVICE);
  });
});

describe('a PagerDuty delivery through the recipe', () => {
  it('selects a triggered incident and builds the triage inputs', () => {
    const { built, facts } = build(body());
    expect(inboundEventSource.mismatch(filters, facts)).toBeNull();
    expect(built.ok).toBe(true);
    expect(built.ok && built.payload).toMatchObject({
      connectionId: REPO,
      incidentId: 'Q2ZH7Y2SD3X0RE',
      mode: 'triage',
      pagerdutyConnectionId: PD_CONNECTION,
    });
  });

  it('does not select another event type or another service', () => {
    expect(
      inboundEventSource.mismatch(filters, build(body({ type: 'incident.resolved' })).facts)
    ).not.toBeNull();
    expect(
      inboundEventSource.mismatch(filters, build(body({ service: 'POTHER1' })).facts)
    ).toContain('/event/data/service/id');
  });

  it('refuses an incident id that is not a PagerDuty id', () => {
    for (const id of ['q2zh7y2', '../../users', 'Q2ZH 7Y2', 'A'.repeat(33)]) {
      expect(build(body({ incident: id })).built.ok, id).toBe(false);
    }
  });
});
