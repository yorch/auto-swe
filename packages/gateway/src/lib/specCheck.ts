import {
  assertShellImageAllowed,
  findAuthoredCommandNodes,
  findContainerCodeNodes,
  findInternalSteps,
  findInvalidPresentation,
  formatValidationIssue,
  isCommandGateStep,
  parseWorkflowSpec,
  ShellImageNotAllowedError,
  SPEC_SCHEMA_VERSION,
  validateSpec,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import { findSpecRefProblems } from './specRefValidation.js';

// The spec checks the template save routes run, kept in one place so the read-only
// `POST /workflow-templates/validate` reports exactly what a save would refuse or warn
// about, from the same functions rather than a second copy of the rules.

export interface ShellNodeWithId {
  id: string;
  /** Structural subset shared by `shell` and `containerStep` — both run a
   *  team-authored image+command and are gated/audited identically. */
  node: { image: string; command: string; network?: 'none' | 'egress' };
}

// `shell`, `containerStep`, and a plain `step` node naming a `shell`-category step
// (`runContainerStep`) all execute team-authored code in a container, so they share
// the same authoring RBAC, image allowlist, and audit trail. Membership is decided by
// the shared `isContainerCodeNode`, the same predicate every worker-side draft path
// refuses on; this function only projects each node onto the image/command shape.
export function collectShellNodes(spec: WorkflowSpec): ShellNodeWithId[] {
  const out: ShellNodeWithId[] = [];
  for (const [id, node] of findContainerCodeNodes(spec)) {
    if (node.type === 'shell') {
      out.push({ id, node });
    } else if (node.type === 'containerStep') {
      out.push({
        id,
        node: { command: node.command ?? '', image: node.image, network: node.network },
      });
    } else if (node.type === 'step') {
      const cfg = node.config ?? {};
      out.push({
        id,
        node: {
          command: typeof cfg.command === 'string' ? cfg.command : '',
          // A non-string image cannot pass the allowlist; '' makes that check refuse it.
          image: typeof cfg.image === 'string' ? cfg.image : '',
          network: cfg.network === 'none' || cfg.network === 'egress' ? cfg.network : undefined,
        },
      });
    }
  }
  return out;
}

/**
 * The `image` an authored-command audit row records. An authored gate or eval command runs in
 * the run's agent workspace (the repository's executor image, chosen by the deployment), not
 * in an image the spec names, so the row says where it ran instead of naming one.
 */
export const AGENT_WORKSPACE_AUDIT_IMAGE = '(agent workspace)';

/** How an audit row spells a command the spec binds from a run-time input. */
function boundCommand(field: string, binding: unknown): string {
  return `(bound at run time: ${field} = ${JSON.stringify(binding) ?? 'undefined'})`;
}

function gateScorerCommands(scorers: unknown): string[] {
  if (!Array.isArray(scorers)) {
    return [];
  }
  return scorers.flatMap((s: unknown) => {
    const scorer = s as { kind?: unknown; command?: unknown } | null;
    return scorer?.kind === 'gate' &&
      typeof scorer.command === 'string' &&
      scorer.command.trim() !== ''
      ? [scorer.command]
      : [];
  });
}

/** The command strings one authored-command node writes into the spec (see `containerCode.ts`). */
function authoredCommandsOf(node: WorkflowSpec['nodes'][string]): string[] {
  if (node.type === 'eval') {
    return gateScorerCommands(node.scorers);
  }
  if (node.type !== 'step') {
    return [];
  }
  const config = node.config ?? {};
  const inputs = (node.inputs ?? {}) as Record<string, unknown>;
  if (isCommandGateStep(node.step)) {
    if (typeof config.command === 'string' && config.command.trim() !== '') {
      return [config.command];
    }
    return 'command' in inputs ? [boundCommand('inputs.command', inputs.command)] : [];
  }
  if (node.step === 'runQualityGates') {
    const gates = Array.isArray(config.gates) ? (config.gates as unknown[]) : [];
    const written = gates.flatMap((g) => {
      const command = (g as { command?: unknown } | null)?.command;
      return typeof command === 'string' && command.trim() !== '' ? [command] : [];
    });
    return 'gates' in inputs ? [...written, boundCommand('inputs.gates', inputs.gates)] : written;
  }
  if (node.step === 'runEvalNode') {
    return gateScorerCommands(config.scorers);
  }
  return [];
}

/**
 * Every command an author wrote into a gate step, a `runQualityGates` gate, or an eval `gate`
 * scorer, one entry per command, projected onto the audit shape. Membership is the shared
 * `isAuthoredCommandNode`; these run in the agent workspace, so the image allowlist does not
 * apply to them and they are never passed to {@link assertShellImagesAllowed}. They carry the
 * same authoring role and `WorkflowShellAudit` trail as container code.
 */
export function collectAuthoredCommandNodes(spec: WorkflowSpec): ShellNodeWithId[] {
  const out: ShellNodeWithId[] = [];
  for (const [id, node] of findAuthoredCommandNodes(spec)) {
    const commands = authoredCommandsOf(node);
    // The predicate and this projection read the same fields; a node the predicate counts
    // still yields a row if they ever disagree, so the gate cannot silently pass it.
    for (const command of commands.length > 0 ? commands : ['(authored command)']) {
      out.push({ id, node: { command, image: AGENT_WORKSPACE_AUDIT_IMAGE, network: 'egress' } });
    }
  }
  return out;
}

/**
 * The code an author wrote into a spec, split by the gates that apply to it: `shellNodes`
 * (container code) take the image allowlist; `authoredNodes` is every node that needs the
 * shell authoring role and a `WorkflowShellAudit` row — container code and authored commands.
 */
export function collectAuthoredCode(spec: WorkflowSpec): {
  shellNodes: ShellNodeWithId[];
  authoredNodes: ShellNodeWithId[];
} {
  const shellNodes = collectShellNodes(spec);
  return { authoredNodes: [...shellNodes, ...collectAuthoredCommandNodes(spec)], shellNodes };
}

/**
 * Authoring a spec with any container code or authored command requires the
 * `workflow:write:shell` permission. We map it to:
 *   - platform ADMIN, OR
 *   - team-role ADMIN in the template's owning team (templates with
 *     teamId === null are global → only platform ADMINs may save shell
 *     nodes there).
 * Returns a Fastify reply on failure, or null on success.
 */
export async function assertShellAuthoringAllowed(
  fastify: FastifyInstance,
  user: JwtPayload,
  teamId: string | null,
  shellNodes: ShellNodeWithId[]
): Promise<{ statusCode: number; body: unknown } | null> {
  if (shellNodes.length === 0) {
    return null;
  }
  if (user.role === 'ADMIN') {
    return null;
  }
  if (teamId === null) {
    return {
      body: {
        error: {
          code: 'SHELL_AUTHOR_FORBIDDEN',
          message:
            'Only platform admins may author shell steps or gate commands on global templates',
        },
      },
      statusCode: 403,
    };
  }
  const membership = await fastify.prisma.teamMembership.findUnique({
    where: { userId_teamId: { teamId, userId: user.sub } },
  });
  if (membership?.role !== 'ADMIN') {
    return {
      body: {
        error: {
          code: 'SHELL_AUTHOR_FORBIDDEN',
          message: 'Authoring shell steps or gate commands requires team-admin role',
        },
      },
      statusCode: 403,
    };
  }
  return null;
}

export async function assertShellImagesAllowed(
  fastify: FastifyInstance,
  teamId: string | null,
  shellNodes: ShellNodeWithId[]
): Promise<
  { ok: true; egressAllowlist: string[] } | { ok: false; statusCode: number; body: unknown }
> {
  if (shellNodes.length === 0) {
    return { egressAllowlist: [], ok: true };
  }
  const team = teamId
    ? await fastify.prisma.team.findUnique({
        select: { egressAllowlist: true, shellImageAllowlist: true },
        where: { id: teamId },
      })
    : null;
  const teamAllowlist = team?.shellImageAllowlist ?? [];
  for (const { id, node } of shellNodes) {
    try {
      assertShellImageAllowed(node.image, teamAllowlist);
    } catch (err) {
      if (err instanceof ShellImageNotAllowedError) {
        return {
          body: {
            error: {
              code: 'SHELL_IMAGE_NOT_ALLOWED',
              message: `Node '${id}': ${err.message}`,
            },
          },
          ok: false,
          statusCode: 400,
        };
      }
      throw err;
    }
  }
  return { egressAllowlist: team?.egressAllowlist ?? [], ok: true };
}

/** One reason a spec cannot be parsed. `message` is human-readable; `nodeId`/`field` locate it. */
export interface SpecParseIssue {
  code: string;
  message: string;
  nodeId?: string;
  field?: string;
}

export type SpecParseResult =
  | { ok: true; spec: WorkflowSpec }
  | { ok: false; message: string; issues: SpecParseIssue[] };

/** Locates a Zod issue: `nodes.<id>.<field…>` names a node and the field inside it. */
function zodIssueLocation(path: unknown): Pick<SpecParseIssue, 'nodeId' | 'field'> {
  if (!Array.isArray(path)) {
    return {};
  }
  // A path outside `nodes` (name, entry, …) names a top-level field; keeping it lets two
  // distinct top-level failures stay distinct and match the editor's own finding.
  if (path[0] !== 'nodes' || typeof path[1] !== 'string') {
    const top = path.map(String).join('.');
    return top ? { field: top } : {};
  }
  const rest = path.slice(2).map(String).join('.');
  return { field: rest || undefined, nodeId: path[1] };
}

/**
 * The strict parse every save runs, with its failure reasons kept apart. `message` is exactly
 * what the save routes put in their 400 body, so `parseSpecOrThrow` and the validate route cannot
 * disagree about what is wrong; `issues` is the same finding split per node for display.
 */
export function parseSpec(input: unknown): SpecParseResult {
  // Strict check: the spec must already declare the current SPEC_SCHEMA_VERSION.
  // The codemod machinery runs at workflow start (templates.ts → migrateSpec) to
  // upgrade already-stored specs, but the editor is expected to migrate before
  // saving, so we don't auto-upgrade here — otherwise older clients could
  // silently round-trip a spec they don't fully understand.
  const spec = input as { schemaVersion?: unknown } | null;
  if (!spec || typeof spec !== 'object') {
    const message = 'spec must be an object';
    return { issues: [{ code: 'SPEC_NOT_OBJECT', message }], message, ok: false };
  }
  if (spec.schemaVersion !== SPEC_SCHEMA_VERSION) {
    const message = `spec.schemaVersion must be ${SPEC_SCHEMA_VERSION} (got ${String(spec.schemaVersion)})`;
    return {
      issues: [{ code: 'SCHEMA_VERSION', field: 'schemaVersion', message }],
      message,
      ok: false,
    };
  }
  // Reading `group`/`title` is tolerant (a bad value degrades to absent), so an authored
  // spec is held to their limits here, before the parse would quietly drop the value.
  const badPresentation = findInvalidPresentation(input);
  if (badPresentation.length > 0) {
    return {
      issues: badPresentation.map((message) => {
        const m = /^node '(.*)'\.(group|title) /.exec(message);
        return {
          code: 'INVALID_PRESENTATION',
          message,
          ...(m ? { field: m[2], nodeId: m[1] } : {}),
        };
      }),
      message: badPresentation.join('; '),
      ok: false,
    };
  }
  let parsed: WorkflowSpec;
  try {
    parsed = parseWorkflowSpec(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid spec';
    const zodIssues = (err as { issues?: unknown }).issues;
    const issues: SpecParseIssue[] = Array.isArray(zodIssues)
      ? zodIssues.map((i: { path?: unknown; message?: unknown }) => ({
          code: 'SCHEMA_INVALID',
          message: typeof i.message === 'string' ? i.message : 'invalid value',
          ...zodIssueLocation(i.path),
        }))
      : [];
    return {
      issues: issues.length > 0 ? issues : [{ code: 'SCHEMA_INVALID', message }],
      message,
      ok: false,
    };
  }
  // An internal step (the Agent Run workspace + push step) is the platform's: an
  // authored template may not name one. The worker refuses to run it elsewhere
  // too; this is the early, readable refusal.
  const internal = findInternalSteps(parsed);
  if (internal.length > 0) {
    return {
      issues: internal.map((i) => ({
        code: 'INTERNAL_STEP',
        field: 'step',
        message: `step '${i.step}' is internal to a platform template and cannot be used in an authored workflow`,
        ...(i.nodeId ? { nodeId: i.nodeId } : {}),
      })),
      message: `step '${internal[0]?.step}' is internal to a platform template and cannot be used in an authored workflow`,
      ok: false,
    };
  }
  return { ok: true, spec: parsed };
}

export function parseSpecOrThrow(input: unknown): unknown {
  const result = parseSpec(input);
  if (!result.ok) {
    throw Object.assign(new Error(result.message), { statusCode: 400 });
  }
  return result.spec;
}

/**
 * Static pre-execution findings for a spec, formatted as non-blocking save
 * warnings (mirrors `validateSpecRefs`). We deliberately DON'T block save on
 * these — a work-in-progress draft may legitimately not terminate yet, and the
 * generation loop already hard-gates AI output on `validateSpec().errors`. The
 * canvas can surface these as live lint.
 */
export function specValidationWarnings(spec: WorkflowSpec): string[] {
  const report = validateSpec(spec);
  return [...report.errors, ...report.warnings].map(formatValidationIssue);
}

/**
 * Lint errors in a stored version's spec. A draft with errors may be saved, but a version that
 * serves real runs (promoted, activated, or an experiment arm) must have none.
 */
export function specErrorsOf(spec: unknown): string[] {
  return validateSpec(spec as WorkflowSpec).errors.map(formatValidationIssue);
}

export type SpecCheckSource = 'schema' | 'lint' | 'refs' | 'authoring';

/** One finding of `checkSpec`; `source` says which of the save path's checks produced it. */
export interface SpecCheckIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  field?: string;
  source: SpecCheckSource;
}

/**
 * Everything a save of `input` into a template owned by `teamId` (null = global) would refuse
 * or warn about, as data and without writing anything:
 *   - schema    the strict parse (a save answers 400 INVALID_SPEC); stops there, as the save does
 *   - lint      `validateSpec` (a save only warns; promote/activate refuse its errors with 409)
 *   - refs      unresolved agent / mcp / eval-rubric references (a save only warns)
 *   - authoring the shell-authoring role gate (a save answers 403) and the shell image allowlist
 *               (a save answers 400), both for `user` on that team
 */
export async function checkSpec(
  fastify: FastifyInstance,
  user: JwtPayload,
  teamId: string | null,
  input: unknown
): Promise<SpecCheckIssue[]> {
  const parsed = parseSpec(input);
  if (!parsed.ok) {
    return parsed.issues.map((i) => ({
      ...i,
      severity: 'error' as const,
      source: 'schema' as const,
    }));
  }
  const spec = parsed.spec;
  const issues: SpecCheckIssue[] = [];

  const report = validateSpec(spec);
  for (const i of [...report.errors, ...report.warnings]) {
    issues.push({
      code: i.code,
      ...(i.field ? { field: i.field } : {}),
      message: i.message,
      ...(i.nodeId ? { nodeId: i.nodeId } : {}),
      severity: i.severity,
      source: 'lint',
    });
  }

  for (const p of await findSpecRefProblems(fastify.prisma, spec, teamId)) {
    issues.push({ ...p, severity: 'warning', source: 'refs' });
  }

  const { authoredNodes, shellNodes } = collectAuthoredCode(spec);
  const [rbac, imgGate] = await Promise.all([
    assertShellAuthoringAllowed(fastify, user, teamId, authoredNodes),
    assertShellImagesAllowed(fastify, teamId, shellNodes),
  ]);
  for (const refusal of [rbac, imgGate.ok ? null : imgGate]) {
    if (!refusal) {
      continue;
    }
    const error = (refusal.body as { error: { code: string; message: string } }).error;
    const node = /^Node '(.*?)': /.exec(error.message);
    issues.push({
      code: error.code,
      message: node ? error.message.slice(node[0].length) : error.message,
      ...(node ? { nodeId: node[1] } : {}),
      severity: 'error',
      source: 'authoring',
    });
  }
  return issues;
}
