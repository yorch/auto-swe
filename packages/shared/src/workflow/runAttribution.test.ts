import { describe, expect, it } from 'vitest';
import { resolveWorkflowRunAttribution } from './runAttribution.js';

const team = (id: string, orgId = `${id}-org`) => ({ team: { id, orgId } });

describe('resolveWorkflowRunAttribution', () => {
  it('prefers the run connection', () => {
    expect(
      resolveWorkflowRunAttribution({
        channel: team('channel-team'),
        connection: team('run-team'),
        template: team('template-team'),
        workRequest: {
          billingOrgId: 'billing-org',
          connection: team('request-team'),
          requestedByService: team('service-team'),
        },
      })
    ).toEqual({ attributedOrgId: 'run-team-org', attributedTeamId: 'run-team' });
  });

  it('uses the work-request connection when the run has none', () => {
    expect(
      resolveWorkflowRunAttribution({
        channel: team('channel-team'),
        template: team('template-team'),
        workRequest: {
          connection: team('request-team'),
          requestedByService: team('service-team'),
        },
      })
    ).toEqual({ attributedOrgId: 'request-team-org', attributedTeamId: 'request-team' });
  });

  it('uses the channel when the run and work request have no connection', () => {
    expect(
      resolveWorkflowRunAttribution({
        channel: team('channel-team'),
        template: team('template-team'),
        workRequest: { requestedByService: team('service-team') },
      })
    ).toEqual({ attributedOrgId: 'channel-team-org', attributedTeamId: 'channel-team' });
  });

  it('uses the service-principal team before the template team', () => {
    expect(
      resolveWorkflowRunAttribution({
        template: team('template-team'),
        workRequest: { requestedByService: team('service-team') },
      })
    ).toEqual({ attributedOrgId: 'service-team-org', attributedTeamId: 'service-team' });
  });

  it('falls back to the template team', () => {
    expect(resolveWorkflowRunAttribution({ template: team('template-team') })).toEqual({
      attributedOrgId: 'template-team-org',
      attributedTeamId: 'template-team',
    });
  });

  it('uses billingOrgId only when no team is available', () => {
    expect(
      resolveWorkflowRunAttribution({
        workRequest: { billingOrgId: 'billing-org', connection: null, requestedByService: null },
      })
    ).toEqual({ attributedOrgId: 'billing-org', attributedTeamId: null });
  });

  it('returns null attribution when every source is absent', () => {
    expect(resolveWorkflowRunAttribution({})).toEqual({
      attributedOrgId: null,
      attributedTeamId: null,
    });
  });
});
