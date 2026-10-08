import { normalizeModelSpec } from '@auto-swe/shared/lib/modelSpec';
import { z } from 'zod';

function isWellFormed(spec: string): boolean {
  try {
    normalizeModelSpec(spec);
    return true;
  } catch {
    return false;
  }
}

/**
 * A `<provider>/<model-id>` spec, stored in canonical form (provider lowercased,
 * model id as written). The worker routes and finds credentials by the lowercased
 * provider, while pricing, the catalog and the runtime checks compare the stored
 * text; storing it canonical keeps every reader agreeing on which model it is. A
 * spec with no provider (`gpt-6-luna`) is refused here instead of failing every
 * run that resolves it.
 */
export const ModelSpecSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .refine(isWellFormed, 'must be <provider>/<model-id>')
  .transform(normalizeModelSpec);
