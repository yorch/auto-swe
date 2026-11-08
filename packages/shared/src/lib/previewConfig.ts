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
    /**
     * Names of `env` keys whose values look random but are not secrets (a commit SHA, a UUID):
     * the random-value check skips them. Name and token-shape checks still apply.
     */
    publicEnv: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
      .max(50)
      .refine((names) => new Set(names).size === names.length, 'must not repeat a name')
      .optional(),
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
  // A JSON Web Token: base64url header and payload, the header starting `{"`.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;

/** Shortest run of key-like characters (`-` and `_` left out) the random-value check considers. */
const RANDOM_RUN_MIN_CHARS = 16;

function charClass(c: string): number {
  return c >= 'a' && c <= 'z' ? 0 : c >= 'A' && c <= 'Z' ? 1 : c >= '0' && c <= '9' ? 2 : 3;
}

function shannonBitsPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let bits = 0;
  for (const n of counts.values()) {
    bits -= (n / s.length) * Math.log2(n / s.length);
  }
  return bits;
}

/**
 * Whether a value holds a run that looks like a generated key: a UUID, 32 or more hex digits, or
 * at least 16 base64, base64url or hex characters (ignoring `-` and `_`), varied enough (3 bits a character or more), and switching
 * between lower case, upper case, digits and symbols on at least a third of its characters. Words
 * joined with separators (`my_feature_flag_2024`, `eu-west-1`) and paths switch far less often.
 */
export function looksRandom(value: string): boolean {
  // Digit-heavy hex (a UUID, a SHA) switches classes too rarely for the run check below.
  if (UUID.test(value) || [...value.matchAll(LONG_HEX)].some((m) => /[a-f]/i.test(m[0]))) {
    return true;
  }
  for (const run of value.match(/[A-Za-z0-9+/=_-]{16,}/g) ?? []) {
    const s = run.replace(/[-_]/g, '');
    if (s.length < RANDOM_RUN_MIN_CHARS) {
      continue;
    }
    let switches = 0;
    for (let i = 1; i < s.length; i++) {
      if (charClass(s[i] as string) !== charClass(s[i - 1] as string)) {
        switches++;
      }
    }
    if (shannonBitsPerChar(s) >= 3 && switches >= s.length / 3) {
      return true;
    }
  }
  return false;
}

/**
 * The keys of a preview recipe's `env` that look like they hold a secret, by name (`*_TOKEN`,
 * `*PASSWORD`, …), by value (URL userinfo, an auth header, a well-known token prefix, a private
 * key, a JWT), or because the value looks random ({@link looksRandom}) and the key is not listed in
 * `publicEnv`. A heuristic: it catches the common shapes, it does not prove the rest are safe.
 */
export function secretLookingEnvKeys(
  env: Record<string, string> | undefined | null,
  publicEnv: readonly string[] = []
): string[] {
  const isPublic = new Set(publicEnv);
  return Object.entries(env ?? {})
    .filter(
      ([name, value]) =>
        value !== '' &&
        (SECRET_LOOKING_NAME.test(name) ||
          SECRET_LOOKING_VALUE.some((re) => re.test(value)) ||
          (!isPublic.has(name) && looksRandom(value)))
    )
    .map(([name]) => name)
    .sort();
}

/** The error code for a preview recipe whose `env` holds secret-looking values. */
export const PREVIEW_ENV_LOOKS_SECRET = 'PREVIEW_ENV_LOOKS_SECRET';
