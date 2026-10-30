import { z } from 'zod';

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
  })
  .strict();

const PreviewConfigInputSchema = z
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
  .strict();

export const PreviewConfigSchema = PreviewConfigInputSchema.transform((config) => ({
  ...config,
  baseUrl: config.baseUrl ?? new URL(config.readyUrl).origin,
  readyTimeoutMs: config.readyTimeoutMs ?? 180_000,
}));

export type PreviewConfig = z.infer<typeof PreviewConfigSchema>;
export type PreviewConfigInput = z.input<typeof PreviewConfigSchema>;
