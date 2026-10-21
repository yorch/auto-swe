import { setDefaultFetchForTests } from './packages/shared/src/lib/guardedDispatcher.js';

// Production always drives the pinned dispatcher with undici's own fetch. Many suites stub
// `globalThis.fetch` instead of passing `fetchImpl`, so under test a replaced global wins, as it
// did before the dispatcher; an untouched global falls through to undici (the pinning tests).
const nativeFetch = globalThis.fetch;
const { fetch: undiciFetch } = await import('undici');
setDefaultFetchForTests(((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  globalThis.fetch === nativeFetch
    ? (undiciFetch as unknown as typeof fetch)(input, init)
    : globalThis.fetch(input, init)) as typeof fetch);

// Testing Library's `findBy*` and `waitFor` give up after 1 s of wall-clock time by default. That
// is a budget for the clock, not for work done, so a CPU-starved runner (a full `yarn test` beside
// builds) can spend all of it on a cold first render and a role query while the component is still
// loading, and the test fails with "Unable to find" although nothing is wrong. Each wait still
// returns the moment its condition holds, so a larger limit costs nothing when the machine is
// healthy and only a real failure waits it out. Only jsdom suites have a DOM to wait on.
//
// The same goes for the 5 s per-test limit on a component test: the first render and the first
// role query in a file are one-time costs of about 0.8 s of CPU, which a starved runner stretches
// past 5 s (measured; the later tests in the file take milliseconds). So jsdom suites get 20 s.
// Node suites keep the default.
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/dom');
  configure({ asyncUtilTimeout: 10_000 });
  const { vi } = await import('vitest');
  vi.setConfig({ testTimeout: 20_000 });
}
