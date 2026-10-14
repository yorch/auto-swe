/**
 * A test-only event source whose automations target a TEAM, not a repository. No shipped source
 * does yet; this one proves the engine, routes and ledger hold such automations. It is never in
 * `EVENT_SOURCES`: a test registers it by mocking `@auto-swe/shared/automation`:
 *
 *   vi.mock('@auto-swe/shared/automation', async (orig) =>
 *     (await import('../test/fakeTeamSource.js')).withFakeTeamSource(await orig())
 *   );
 */
import type { EventSource } from '@auto-swe/shared/automation';
import { z } from 'zod';

export const FAKE_TEAM_SOURCE = 'test.team.event';

const FiltersSchema = z.object({ topics: z.array(z.string().min(1)).min(1) });
const FactsSchema = z.object({ eventId: z.string().min(1), topic: z.string().min(1) });
type Filters = z.infer<typeof FiltersSchema>;
type Facts = z.infer<typeof FactsSchema>;

export const fakeTeamSource: EventSource<Filters, Facts> = {
  dedupeKey: (ownerKey, x) => `${ownerKey}#${x.eventId}`,
  defaultFilters: { topics: ['deploys'] },
  defaultTemplate: { name: 'team-default' },
  describe: (f) => `about ${f.topics.join(', ')}`,
  describeOccurrence: (f) => `event ${String(f.eventId)}`,
  eventInputKeys: [],
  facts: FactsSchema,
  filterFields: [{ key: 'topics', kind: 'list', label: 'Topics' }],
  filters: FiltersSchema,
  inFlightLookbackMs: 60 * 60 * 1000,
  key: FAKE_TEAM_SOURCE,
  keys: (x) => ({ scope: x.topic, subject: x.eventId }),
  killSwitch: 'github.issueLabelAutomationsEnabled',
  label: 'When a team event arrives',
  mismatch: (f, x) => (f.topics.includes(x.topic) ? null : `not about ${f.topics.join(', ')}`),
  run: (x) => ({
    description: `Handle ${x.topic} event ${x.eventId}`,
    fields: {},
    ticketId: `evt-${x.eventId}`,
    ticketIsSynthetic: true,
  }),
  samples: (f) => [{ eventId: 'sample', topic: f.topics[0] ?? 'deploys' }],
  summary: 'A test event for a team.',
  target: 'team',
  templateCompatible: () => true,
  tester: {
    facts: (v) => ({ eventId: 'test', topic: v.topic ?? 'deploys' }),
    fields: [{ initial: 'deploys', key: 'topic', label: 'Topic' }],
  },
  workflowId: { part: (x) => x.eventId, prefix: 'evt' },
};

/** The shared automation module with the fake source registered beside the real ones. */
export function withFakeTeamSource<M extends Record<string, unknown>>(actual: M): M {
  const real = actual as unknown as {
    EVENT_SOURCES: Record<string, unknown>;
    EVENT_SOURCE_KEYS: string[];
    eventSource: (key: string) => unknown;
  };
  return {
    ...actual,
    EVENT_SOURCE_KEYS: [...real.EVENT_SOURCE_KEYS, FAKE_TEAM_SOURCE],
    EVENT_SOURCES: { ...real.EVENT_SOURCES, [FAKE_TEAM_SOURCE]: fakeTeamSource },
    eventSource: (key: string) =>
      key === FAKE_TEAM_SOURCE ? fakeTeamSource : real.eventSource(key),
  };
}
