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
