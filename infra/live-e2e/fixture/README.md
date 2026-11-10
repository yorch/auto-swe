# auto-swe live end-to-end fixture

A tiny Node project with one deliberate bug: `src/sum.js` subtracts, so `test/sum.test.js` and
this repository's CI fail on the default branch. The live end-to-end check opens a ticket against
it, expects a pull request that fixes `sum`, and expects that pull request's CI to go green.

The default branch is never merged into, so the bug stays in place for the next run.
