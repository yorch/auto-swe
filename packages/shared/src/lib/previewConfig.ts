import { z } from 'zod';
import { MAX_REPO_SETUP_SECRETS, RepoSetupSecretNameSchema } from './repoSetup.js';

const LOCAL_URL_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)(?:[/?#]|$)/i;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const LocalPreviewUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    const match = value.match(LOCAL_URL_PATTERN);
    if (!match) {
      return false;
    }
    const port = Number(match[1]);
    return port >= 1 && port <= 65_535;
  }, 'must be an HTTP(S) localhost URL with a port');

const EnvironmentSchema = z
  .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4000))
  .refine((env) => Object.keys(env).length <= 50, 'must contain at most 50 keys');

export const ServiceSchema = z
  .object({
    env: z.record(z.string(), z.string()).optional(),
    image: z.string().min(1),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    port: z.number().int().min(1).max(65_535).optional(),
    readyCommand: z.string().optional(),
    runAsGroup: z.number().int().min(1).max(2_147_483_647).optional(),
    runAsUser: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict()
  .refine((service) => service.runAsGroup === undefined || service.runAsUser !== undefined, {
    message: 'runAsGroup requires runAsUser',
    path: ['runAsGroup'],
  });

/** The recipe as stored, before defaults are filled in. */
export const PreviewConfigInputSchema = z
  .object({
    allowedHosts: z.array(z.string().regex(HOSTNAME_PATTERN)).max(50).optional(),
    baseUrl: LocalPreviewUrlSchema.optional(),
    e2e: z
      .object({
        command: z.string().min(1).max(4000),
        resultsDir: z
          .string()
          .min(1)
          .max(500)
          .refine(
            (value) =>
              !value.includes('..') &&
              !value.startsWith('/') &&
              !value.startsWith('\\') &&
              !/^[A-Za-z]:/.test(value),
            'must be a relative path without ..'
          )
          .default('test-results'),
      })
      .strict()
      .optional(),
    env: EnvironmentSchema.optional(),
    readyTimeoutMs: z.number().int().min(1000).max(900_000).optional(),
    readyUrl: LocalPreviewUrlSchema,
    /**
     * Names of the repository's setup secrets the preview's setup and start commands receive as
     * environment variables; the values are stored encrypted on the repository.
     */
    secrets: z
      .array(RepoSetupSecretNameSchema)
      .max(MAX_REPO_SETUP_SECRETS)
      .refine((names) => new Set(names).size === names.length, 'must not repeat a name')
      .optional(),
    services: z.array(ServiceSchema).max(4).optional(),
    setup: z.string().max(4000).optional(),
    smoke: z
      .array(
        z
          .object({
            name: z.string().max(100).optional(),
            path: z.string().startsWith('/').max(2000),
            waitFor: z.string().max(500).optional(),
          })
          .strict()
      )
      .max(30)
      .optional(),
    start: z.string().min(1).max(4000),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const name of config.secrets ?? []) {
      if (config.env && name in config.env) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} is both an env variable and a secret`,
          path: ['secrets'],
        });
      }
    }
  });

export const PreviewConfigSchema = PreviewConfigInputSchema.transform((config) => ({
  ...config,
  baseUrl: config.baseUrl ?? new URL(config.readyUrl).origin,
  readyTimeoutMs: config.readyTimeoutMs ?? 180_000,
}));

export type PreviewConfig = z.infer<typeof PreviewConfigSchema>;
export type PreviewConfigInput = z.input<typeof PreviewConfigSchema>;

const SECRET_LOOKING_NAME =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)/i;
const SECRET_LOOKING_VALUE = [
  // URL userinfo: https://user:pass@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * The keys of a preview recipe's `env` that look like they hold a secret, by name (`*_TOKEN`,
 * `*PASSWORD`, …) or by value (URL userinfo, an auth header, a well-known token prefix, a
 * private key). A heuristic: it catches the common shapes, it does not prove the rest are safe.
 */
export function secretLookingEnvKeys(env: Record<string, string> | undefined | null): string[] {
  return Object.entries(env ?? {})
    .filter(
      ([name, value]) =>
        value !== '' &&
        (SECRET_LOOKING_NAME.test(name) || SECRET_LOOKING_VALUE.some((re) => re.test(value)))
    )
    .map(([name]) => name)
    .sort();
}

/** The error code for a preview recipe whose `env` holds secret-looking values. */
export const PREVIEW_ENV_LOOKS_SECRET = 'PREVIEW_ENV_LOOKS_SECRET';
