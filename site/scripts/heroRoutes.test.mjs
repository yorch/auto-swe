import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from '../../packages/shared/src/workflow/templates/index.ts';
import { formatTimeout, HERO_ROUTES, stationDetail } from './heroRoutes.mjs';
import { summarizeSpec } from './templateGraph.mjs';

const DURATION = /(\d+)[- ](minute|hour|day)s?\b/g;

/** Every duration a piece of copy states, normalised to `7 days` / `24 hours`. */
function durationsIn(text) {
  return [...text.matchAll(DURATION)].map(([, n, unit]) => formatTimeout(`${n}${unit[0]}`));
}

describe('hero routes', () => {
  for (const route of HERO_ROUTES) {
    describe(route.id, () => {
      const template = BUILTIN_TEMPLATES.find((t) => t.name === route.template);
      const gates = route.stations.filter((s) => s.gate);

      it('plays a built-in template', () => {
        expect(template, route.template).toBeDefined();
      });

      // The panel's whole claim is where a run stops for a person; a gate the
      // spec lacks, or one it has that the panel drops, makes that claim false.
      it('stops exactly where the spec has a person act', () => {
        const people = summarizeSpec(template.spec).people;
        expect(gates.length).toBe(people.length);
      });

      it("uses the spec's own timeouts", () => {
        const specTimeouts = summarizeSpec(template.spec)
          .people.map((p) => p.timeout)
          .sort();
        const routeTimeouts = gates.map((s) => s.gate.timeout).sort();
        expect(routeTimeouts).toEqual(specTimeouts);
      });

      it('states no duration that is not a gate timeout', () => {
        const allowed = new Set(gates.map((s) => formatTimeout(s.gate.timeout)));
        const copy = [
          route.note,
          route.done,
          ...route.stations.flatMap((s) => [stationDetail(s), s.gate?.held ?? '']),
        ].join(' ');
        for (const stated of durationsIn(copy)) {
          expect(allowed.has(stated), stated).toBe(true);
        }
      });
    });
  }
});

describe('formatTimeout', () => {
  it('spells out spec timeouts', () => {
    expect(formatTimeout('7d')).toBe('7 days');
    expect(formatTimeout('24h')).toBe('24 hours');
    expect(formatTimeout('1h')).toBe('1 hour');
  });

  it('refuses a format it does not know rather than guessing', () => {
    expect(() => formatTimeout('PT4H')).toThrow(/Unsupported timeout/);
  });
});
