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
    ).toEqual({
      attributedOrgId: 'run-team-org',
      attributedRepoId: null,
      attributedTeamId: 'run-team',
    });
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
    ).toEqual({
      attributedOrgId: 'request-team-org',
      attributedRepoId: null,
      attributedTeamId: 'request-team',
    });
  });

  it('uses the channel when the run and work request have no connection', () => {
    expect(
      resolveWorkflowRunAttribution({
        channel: team('channel-team'),
        template: team('template-team'),
        workRequest: { requestedByService: team('service-team') },
      })
    ).toEqual({
      attributedOrgId: 'channel-team-org',
      attributedRepoId: null,
      attributedTeamId: 'channel-team',
    });
  });

  it('uses the service-principal team before the template team', () => {
    expect(
      resolveWorkflowRunAttribution({
        template: team('template-team'),
        workRequest: { requestedByService: team('service-team') },
      })
    ).toEqual({
      attributedOrgId: 'service-team-org',
      attributedRepoId: null,
      attributedTeamId: 'service-team',
    });
  });

  it('falls back to the template team', () => {
    expect(resolveWorkflowRunAttribution({ template: team('template-team') })).toEqual({
      attributedOrgId: 'template-team-org',
      attributedRepoId: null,
      attributedTeamId: 'template-team',
    });
  });

  it('attributes a connection-less run on a team-less template to the team that gated its launch', () => {
    expect(
      resolveWorkflowRunAttribution({
        template: { team: null },
        workRequest: {
          billingOrgId: 'billing-org',
          billingTeam: { id: 'billing-team', orgId: 'billing-org' },
        },
      })
    ).toEqual({
      attributedOrgId: 'billing-org',
      attributedRepoId: null,
      attributedTeamId: 'billing-team',
    });
  });

  it('puts the stamped billing team after every other team source', () => {
    expect(
      resolveWorkflowRunAttribution({
        template: team('template-team'),
        workRequest: { billingTeam: { id: 'billing-team', orgId: 'billing-org' } },
      }).attributedTeamId
    ).toBe('template-team');
    expect(
      resolveWorkflowRunAttribution({
        workRequest: {
          billingTeam: { id: 'billing-team', orgId: 'billing-org' },
          requestedByService: team('service-team'),
        },
      }).attributedTeamId
    ).toBe('service-team');
  });

  it('uses billingOrgId only when no team is available', () => {
    expect(
      resolveWorkflowRunAttribution({
        workRequest: { billingOrgId: 'billing-org', connection: null, requestedByService: null },
      })
    ).toEqual({ attributedOrgId: 'billing-org', attributedRepoId: null, attributedTeamId: null });
  });

  it('returns null attribution when every source is absent', () => {
    expect(resolveWorkflowRunAttribution({})).toEqual({
      attributedOrgId: null,
      attributedRepoId: null,
      attributedTeamId: null,
    });
  });

  it('prefers the linked active-workflow repository over the run connection', () => {
    expect(
      resolveWorkflowRunAttribution({
        activeWorkflowRepoId: 'active-repo',
        connectionId: 'run-repo',
      }).attributedRepoId
    ).toBe('active-repo');
    expect(resolveWorkflowRunAttribution({ connectionId: 'run-repo' }).attributedRepoId).toBe(
      'run-repo'
    );
  });
});
