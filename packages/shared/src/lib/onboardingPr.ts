import { stringify } from 'yaml';
import { z } from 'zod';
import { renderToolsFile, TOOLS_FILE_PATH, ToolRequestSchema } from './toolsFile.js';

export {
  ONBOARDING_PR_WORKFLOW_TYPE,
  type OnboardingPrInput,
  type OnboardingPrResult,
  onboardingPrWorkflowId,
} from './onboardingPrWorkflow.js';

/**
 * The contract for "open a pull request that adds this repository's `.auto-swe/` config files".
 * The gateway validates a request and starts the workflow; the worker's activity writes the files
 * and opens the pull request. There is deliberately no free-form path or content input: the only
 * files that can be proposed are the two below, at their fixed paths, rendered from structured
 * data here — so a caller cannot use this to write anywhere else in the repository.
 *
 * Pure and I/O-free. Hashing the rendered content is the gateway's job (it passes the 16-hex
 * digest as `contentHash`), which keeps `node:crypto` out of anything a workflow isolate imports.
 */

export const ONBOARDING_FILE_KINDS = ['tools', 'prPolicy'] as const;
export type OnboardingFileKind = (typeof ONBOARDING_FILE_KINDS)[number];

export const PR_POLICY_FILE_PATH = '.auto-swe/pr-policy.yml';

export const MAX_ONBOARDING_TOOLS = 32;
export const MAX_SENSITIVE_PATHS = 50;
export const MAX_SENSITIVE_PATH_LENGTH = 200;

const SensitivePathSchema = z
  .string()
  .min(1)
  .max(MAX_SENSITIVE_PATH_LENGTH)
  .refine((p) => !p.includes('..'), 'must not contain ".."')
  .refine((p) => !p.startsWith('/'), 'must not start with "/"')
  .refine((p) => !/[\r\n]/.test(p), 'must not contain a newline');

const ToolsFileRequestSchema = z.strictObject({
  kind: z.literal('tools'),
  tools: z
    .array(ToolRequestSchema)
    .min(1)
    .max(MAX_ONBOARDING_TOOLS)
    .refine((tools) => new Set(tools.map((t) => t.key)).size === tools.length, {
      message: 'a tool key may be named only once',
    }),
});

const PrPolicyFileRequestSchema = z.strictObject({
  kind: z.literal('prPolicy'),
  sensitivePaths: z.array(SensitivePathSchema).max(MAX_SENSITIVE_PATHS).optional(),
});

export const OnboardingFileRequestSchema = z.discriminatedUnion('kind', [
  ToolsFileRequestSchema,
  PrPolicyFileRequestSchema,
]);

export const OnboardingRequestSchema = z.strictObject({
  files: z
    .array(OnboardingFileRequestSchema)
    .min(1)
    .max(ONBOARDING_FILE_KINDS.length)
    .refine((files) => new Set(files.map((f) => f.kind)).size === files.length, {
      message: 'at most one entry per file kind',
    }),
});

export type OnboardingRequest = z.infer<typeof OnboardingRequestSchema>;

// Kept in step with `POLICY_TEMPLATE_HEADER` in the CLI (`auto-swe pr-policy init`); shared cannot
// import the CLI or SDK, so the text is copied and the test parses the output with the real parser.
const PR_POLICY_HEADER = `# auto-swe pull request policy (.auto-swe/pr-policy.yml)
#
# The platform's defaults apply in full. This file can only make pull request evaluation
# STRICTER: add sensitive or high-risk paths, lower the LOW-class limits, lower highLines,
# raise approver counts, or name required reviewers. It cannot lower an approver count,
# raise a threshold, disable a default exclusion, or set the evaluation mode. Any such key
# is ignored, and \`auto-swe pr-policy validate\` reports it.
#
# The platform reads this file from the base branch.
version: 1
`;

function renderPrPolicyFile(sensitivePaths: readonly string[] | undefined): string {
  if (!sensitivePaths || sensitivePaths.length === 0) {
    return PR_POLICY_HEADER;
  }
  const list = stringify({ sensitivePaths }, { lineWidth: 0 });
  return `${PR_POLICY_HEADER}\n# Paths whose changes are never LOW risk.\n${list}`;
}

/** The files a request proposes, in a fixed order (`tools`, then `prPolicy`), deterministic. */
export function renderOnboardingFiles(
  request: OnboardingRequest
): { path: string; content: string }[] {
  const parsed = OnboardingRequestSchema.parse(request);
  const out: { path: string; content: string }[] = [];
  for (const kind of ONBOARDING_FILE_KINDS) {
    const file = parsed.files.find((f) => f.kind === kind);
    if (file?.kind === 'tools') {
      out.push({ content: renderToolsFile(file.tools), path: TOOLS_FILE_PATH });
    } else if (file?.kind === 'prPolicy') {
      out.push({ content: renderPrPolicyFile(file.sensitivePaths), path: PR_POLICY_FILE_PATH });
    }
  }
  return out;
}
