import { SETTING_DEFINITIONS } from '@auto-swe/shared/config';
import { AGENT_RUN_MAX_WALL_CLOCK_SECONDS } from '@auto-swe/shared/lib/agentRun';
import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_CEILING_SECONDS,
  AGENT_RUN_HEADROOM_SECONDS,
  T_AGENT_RUN_ACTIVITY,
  T_AGENT_RUN_ACTIVITY_SECONDS,
} from './proxyOptions.js';

describe('agent run activity timeout', () => {
  it('mirrors the setting’s hard maximum (workflow code cannot import it)', () => {
    expect(AGENT_RUN_CEILING_SECONDS).toBe(AGENT_RUN_MAX_WALL_CLOCK_SECONDS);
    const schema = SETTING_DEFINITIONS['workspace.agentRunMaxWallClockSeconds'].schema;
    expect(schema.safeParse(AGENT_RUN_MAX_WALL_CLOCK_SECONDS).success).toBe(true);
    expect(schema.safeParse(AGENT_RUN_MAX_WALL_CLOCK_SECONDS + 1).success).toBe(false);
  });

  it('leaves at least 90 minutes beyond the largest wall-clock cap', () => {
    expect(AGENT_RUN_HEADROOM_SECONDS).toBeGreaterThanOrEqual(90 * 60);
    expect(T_AGENT_RUN_ACTIVITY_SECONDS).toBe(
      AGENT_RUN_MAX_WALL_CLOCK_SECONDS + AGENT_RUN_HEADROOM_SECONDS
    );
    expect(T_AGENT_RUN_ACTIVITY).toBe(`${T_AGENT_RUN_ACTIVITY_SECONDS}s`);
  });
});
