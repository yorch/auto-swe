/**
 * Import this for its side effect from a test (a route test, or one that drives `requireAuth`
 * directly) whose first request can arrive without a Bearer token.
 *
 * Such a request falls through to `verifyBetterAuthSession` (`plugins/auth.ts`), which
 * lazy-loads the whole better-auth module graph (about 1.2 s cold). Left alone, that cost
 * lands inside whichever test sends the first token-less request and counts against its
 * 5 s timeout, so a loaded machine fails an assertion-free 401 test on module loading alone.
 * Loading the graph at import time moves it to the collection phase, which has no such limit.
 * The modules are the ones the plugin imports, so mocks registered by the test still apply.
 * `allSettled`: a test that partially mocks `systemConfig` makes `betterAuth.js` throw on load,
 * which the plugin already treats as "no session"; warming must not turn that into a failure.
 */
await Promise.allSettled([import('../lib/betterAuth.js'), import('better-auth/node')]);
