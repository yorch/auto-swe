import { z } from 'zod';

/** Build a bounded `{ limit, offset }` querystring schema. Each caller passes
 *  its own caps so existing per-route behavior is preserved exactly. */
export function paginationQuery(opts: { maxLimit: number; defaultLimit: number }) {
  return z.object({
    limit: z.coerce.number().int().min(1).max(opts.maxLimit).default(opts.defaultLimit),
    offset: z.coerce.number().int().min(0).default(0),
  });
}
