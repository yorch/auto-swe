import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';

/**
 * Request schemas for a GitHub platform credential, shared by the instance's
 * GitHub integration and the per-host credentials so both refuse the same bad
 * input at save time instead of storing a credential that can never work.
 */

// A pasted trailing newline is the common way to store a token that can never
// authenticate, so edge whitespace is refused rather than trimmed silently.
export const GitHubTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => v === v.trim(), 'must not start or end with whitespace');

// A PEM legitimately ends in a newline, so it is only required to parse.
export const GitHubAppPrivateKeySchema = z
  .string()
  .min(1)
  .max(10_000)
  .refine((v) => {
    try {
      createPrivateKey(v);
      return true;
    } catch {
      return false;
    }
  }, 'must be a PEM private key');

export const GitHubAppIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[0-9]+$/, 'must be the numeric GitHub App id');
