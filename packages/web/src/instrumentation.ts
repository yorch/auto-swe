/**
 * Runs once when the server starts. It begins building the docs search index in the background
 * so the first search of a person who opens the docs does not pay for it.
 *
 * The build is deliberately not awaited: Next holds the server back until `register` returns,
 * and a slow or failing index must never delay or prevent start-up. A failure is logged and the
 * first search simply builds the index itself (`loadDocSearchIndex` does not keep a failed build).
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }
  void import('@/lib/docs')
    .then(({ loadDocSearchIndex }) => loadDocSearchIndex())
    .catch((error: unknown) => {
      console.error('[instrumentation] docs search warm-up failed', error);
    });
}
