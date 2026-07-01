import {
  CHANNEL_TASK_PLANNER_PROMPT,
  CHANNEL_TASK_SYNTHESIZER_PROMPT,
} from '@auto-swe/shared/lib/agentPrompts';
import { heartbeat } from '@temporalio/activity';
import { z } from 'zod';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { runAgent } from './runAgent.js';

/** Hard cap on how many parallel branches a general channel task may fan out to. */
const MAX_SUBTASKS = 4;

/** Max subtasks run concurrently inside {@link runChannelSubtasks}. */
const BRANCH_CONCURRENCY = 3;

const CHANNEL_ASSISTANT_KEY = 'channelAssistant' as ModelBackedAgentKey;

export interface ChannelSubtask {
  title: string;
  description: string;
}

export interface PlanChannelTaskResult {
  subtasks: ChannelSubtask[];
  /** Always `subtasks.length`; surfaced so the spec's `cond` can branch on it. */
  subtaskCount: number;
}

const PlanSchema = z.object({
  subtasks: z
    .array(
      z.object({
        description: z
          .string()
          .describe(
            'A clear, self-contained description of this subtask (a worker sees only this).'
          ),
        title: z.string().describe('A short title for the subtask.'),
      })
    )
    .min(1)
    .max(MAX_SUBTASKS),
});

/**
 * General-route decomposition planner (`planChannelTask` step). Decides whether a
 * general channel task splits into independent, parallelizable subtasks. Biased
 * toward a SINGLE subtask (the whole task) — the spec's `cond` then routes cohesive
 * work to the single-agent path, and only genuinely splittable tasks fan out.
 *
 * Runs on the channel's `channelAssistant` agent (so per-channel model config +
 * CHANNEL tier apply) with the planner prompt as a system-prompt override and a
 * structured-output schema. NEVER throws: any planning failure (LLM error, empty
 * output) degrades to one subtask (the whole task), so decomposition can never make
 * a channel task worse than the plain single-agent run.
 */
export async function planChannelTask(input: {
  task: string;
  channelId?: string;
  /** Per-node override of the planner prompt (`systemPrompt` step config). */
  systemPrompt?: string;
}): Promise<PlanChannelTaskResult> {
  const whole: ChannelSubtask = { description: input.task, title: 'Task' };
  try {
    const baseCtx = await currentRequestContext();
    // A channel-task run carries its channelId on the request (not derivable from
    // currentRequestContext) — thread it so the CHANNEL config tier picks the
    // per-channel model, matching the agent nodes downstream.
    const ctx = input.channelId ? { ...baseCtx, channelId: input.channelId } : baseCtx;
    const spec = await resolveAgentSpec(
      {
        agentKey: CHANNEL_ASSISTANT_KEY,
        basePrompt: '',
        promptOverride: input.systemPrompt || CHANNEL_TASK_PLANNER_PROMPT,
      },
      ctx
    );
    spec.outputSchema = PlanSchema;

    const result = await runAgent<z.infer<typeof PlanSchema>>(spec, input.task, {
      spanName: 'llm.channel_task.plan',
    });
    const subtasks = (result.object?.subtasks ?? [])
      .filter((s) => typeof s.description === 'string' && s.description.trim().length > 0)
      .slice(0, MAX_SUBTASKS);
    if (subtasks.length === 0) {
      return { subtaskCount: 1, subtasks: [whole] };
    }
    return { subtaskCount: subtasks.length, subtasks };
  } catch {
    // Fail safe: run the whole task on the single-agent path.
    return { subtaskCount: 1, subtasks: [whole] };
  }
}

/**
 * Decompose path for a general channel task (`runChannelSubtasks` step). Runs each
 * planned subtask through the channel's `channelAssistant` agent with bounded
 * concurrency, then synthesizes the partial answers into one coherent reply.
 *
 * The fan runs here (in one activity) rather than as engine `fanOut` nodes because
 * the interpreter can't surface a branch agent's free-text output to a join. Each
 * subtask + the synthesis are still individual traced LLM runs (via `runAgent`), so
 * their cost accrues to the same channel ledger and shows in the run trace.
 *
 * Resilient by construction: a failed subtask contributes no part rather than
 * failing the run; with a single surviving part we skip synthesis; if synthesis
 * itself fails we fall back to joining the parts. Returns `{ text }` — the run
 * result the thread reply is built from.
 */
export async function runChannelSubtasks(input: {
  task: string;
  subtasks: ChannelSubtask[];
  channelId?: string;
  /** Per-node override of the synthesis prompt (`systemPrompt` step config). The
   *  per-subtask branch runs use the channel agent's own configured prompt. */
  systemPrompt?: string;
}): Promise<{ text: string }> {
  const subtasks = (input.subtasks ?? [])
    .filter((s) => typeof s?.description === 'string' && s.description.trim().length > 0)
    .slice(0, MAX_SUBTASKS);
  if (subtasks.length === 0) {
    // Nothing to fan out — run the whole task once.
    subtasks.push({ description: input.task, title: 'Task' });
  }

  const baseCtx = await currentRequestContext();
  const ctx = input.channelId ? { ...baseCtx, channelId: input.channelId } : baseCtx;

  // Resolve the branch agent spec once (channel persona) and reuse it — runAgent
  // builds a fresh Mastra agent per call, so sharing the read-only spec is safe.
  const branchSpec = await resolveAgentSpec(
    { agentKey: CHANNEL_ASSISTANT_KEY, basePrompt: '' },
    ctx
  );

  // Bounded-concurrency worker pool over the subtasks (order preserved by index).
  const answers: string[] = new Array(subtasks.length).fill('');
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= subtasks.length) {
        return;
      }
      heartbeat(`channel subtask ${i + 1}/${subtasks.length}`);
      try {
        const r = await runAgent(branchSpec, (subtasks[i] as ChannelSubtask).description, {
          spanName: 'llm.channel_task.branch',
        });
        answers[i] = (r.text ?? '').trim();
      } catch {
        answers[i] = '';
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BRANCH_CONCURRENCY, subtasks.length) }, () => worker())
  );

  const parts = answers.filter((a) => a.length > 0);
  if (parts.length === 0) {
    return { text: '' };
  }
  if (parts.length === 1) {
    // Only one branch produced an answer — nothing to synthesize.
    return { text: parts[0] as string };
  }

  // Synthesize the parts into one reply.
  heartbeat('channel task: synthesizing');
  try {
    const synthSpec = await resolveAgentSpec(
      {
        agentKey: CHANNEL_ASSISTANT_KEY,
        basePrompt: '',
        promptOverride: input.systemPrompt || CHANNEL_TASK_SYNTHESIZER_PROMPT,
      },
      ctx
    );
    const r = await runAgent(synthSpec, JSON.stringify({ parts, task: input.task }), {
      spanName: 'llm.channel_task.synthesize',
    });
    const text = (r.text ?? '').trim();
    return { text: text.length > 0 ? text : parts.join('\n\n') };
  } catch {
    // Synthesis failed — return the concatenated parts rather than nothing.
    return { text: parts.join('\n\n') };
  }
}
