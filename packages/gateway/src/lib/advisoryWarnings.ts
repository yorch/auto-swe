/**
 * Advice that must never fail the call that produced it: the write has already committed, so a
 * throw here would report a saved change as a failed one and cost the audit entry that follows.
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
