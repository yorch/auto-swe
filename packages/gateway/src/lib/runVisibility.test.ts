import { describe, expect, it } from 'vitest';
import {
  buildWorkflowRunControlFilter,
  buildWorkflowRunVisibilityFilter,
} from './runVisibility.js';

const engineer = { role: 'ENGINEER', sub: 'user-1' };

describe('run visibility versus run control', () => {
  it('lets a shared team see the owning team’s runs', () => {
    const visible = JSON.stringify(buildWorkflowRunVisibilityFilter(engineer, undefined));
    expect(visible).toContain('shares');
  });

  it('does not let a shared team cancel or answer the owning team’s runs', () => {
    // Control reaches repositories through the owning team only — plus the
    // runs the actor launched, so a shared-team member keeps control of theirs.
    const control = buildWorkflowRunControlFilter(engineer, undefined);
    expect(JSON.stringify(control)).not.toContain('shares');
    expect(control.OR).toContainEqual({ launchedById: 'user-1' });
    // Every engineering run uses a global built-in template; that alone must
    // not hand control of the run to every signed-in user.
    expect(control.OR).not.toContainEqual({ template: { teamId: null } });
  });

  it('leaves a platform admin unrestricted', () => {
    expect(buildWorkflowRunControlFilter({ role: 'ADMIN', sub: 'a' }, undefined)).toEqual({});
  });
});
