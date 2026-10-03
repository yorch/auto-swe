/**
 * `Promise.all(items.map(fn))` with at most `limit` calls in flight, results in
 * input order. The gateway's pg pool holds 10 connections, so a report that
 * fans out one query per bucket runs them through this rather than taking the
 * whole pool from auth and webhook traffic.
 *
 * Rejects with the first error, like `Promise.all`, and once any call has
 * failed no worker starts another: the result is already lost, so the rest of
 * the items would only spend pool time. Calls already in flight still finish.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i] as T);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    })
  );
  return out;
}
