/**
 * Advice that must never fail the call that produced it: a throw here would fail (or, after the
 * write has committed, report a saved change as failed and cost the audit entry that follows).
 * Degrades to `fallback` and says so in the log.
 */
export async function advisoryWarnings<T>(
  label: string,
  compute: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await compute();
  } catch (error) {
    console.warn(`Failed to compute ${label} advice; using fallback`, error);
    return fallback;
  }
}
