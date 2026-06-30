import type { ChannelAssistantTurnInput, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { log, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { DelegateIntent } from '../activities/channelAssistant.js';
import type * as activitiesType from '../activities/index.js';
import { startThreadTaskChild } from './taskChild.js';

/**
 * ChannelAssistantWorkflow — channel assistant (Phase 0 + Phase 4 live-progress).
 *
 * One @mention → one reply. The gateway's Slack Events route starts this
 * workflow (name `'ChannelAssistantWorkflow'`, task queue `'engineering-workflow'`)
 * when a user @mentions the bot; it runs the channel's assistant agent and posts
 * the reply back into the originating thread.
 *
 * Phase 4 (multiplayer polish) gives the teammate a "live" feel: a placeholder
 * (":hourglass_flowing_sand: _Working on it…_") is posted into the thread first,
 * then edited in place (chat.update) with the answer once the turn finishes. If
 * the placeholder couldn't be posted we fall back to a fresh reply message; on a
 * turn error we edit the placeholder (or post a fresh message) with friendly
 * error text — preserving the original graceful-fallback behavior.
 *
 * Scope note: true mid-task hand-off and full thread-history context (fetching
 * `conversations.replies`) need a Slack read scope + a long-lived per-channel
 * workflow; they remain future refinements. The shared per-channel agent +
 * channel memory already make the assistant multiplayer (one Claude, shared
 * context) — this phase adds the live-edit UX + input safety (advisory scan of
 * ingested channel content inside `runChannelAssistantTurn`).
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`;
 * runtime imports come from `@temporalio/workflow` and the activity proxies below.
 */

// The LLM turn: generous timeout + a couple retries (transient provider errors).
const { runChannelAssistantTurn } = proxyActivities<
  Pick<typeof activitiesType, 'runChannelAssistantTurn'>
>({
  heartbeatTimeout: '2m',
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 3,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '5m',
});

// The Slack posts: quick network calls. Retry a few times so a transient blip
// doesn't drop the reply, but keep the per-attempt timeout short. The placeholder
// poster and the chat.update editor share these settings with the fresh-post path.
const { postChannelReply, postChannelPlaceholder, updateChannelReply } = proxyActivities<
  Pick<typeof activitiesType, 'postChannelReply' | 'postChannelPlaceholder' | 'updateChannelReply'>
>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '2s',
    maximumAttempts: 4,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '30s',
});

// Run-record lifecycle: a lightweight WorkflowRun keyed to this Temporal
// workflowId so the turn's agent traces (LLM calls inside runChannelAssistantTurn)
// persist + show up in /runs. Quick DB writes — short timeout, a couple retries.
const { startChannelRun, finalizeChannelRun, touchChannelThreadSession } = proxyActivities<
  Pick<
    typeof activitiesType,
    'startChannelRun' | 'finalizeChannelRun' | 'touchChannelThreadSession'
  >
>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '2s',
    maximumAttempts: 3,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '30s',
});

// Phase A: task-launch preparation + budget gate. Quick DB reads/writes — short
// timeout, a couple retries. `createChannelTaskRun` is NOT idempotent (it INSERTs
// a RunInput), but it only runs once per turn (guarded by the `delegate` branch),
// and a duplicate RunInput would be harmless (the reject-duplicate child policy
// keeps a single task run per thread regardless).
const { createChannelTaskRun, createChannelCodeTaskRun, isChannelOverBudgetForTask } =
  proxyActivities<
    Pick<
      typeof activitiesType,
      'createChannelTaskRun' | 'createChannelCodeTaskRun' | 'isChannelOverBudgetForTask'
    >
  >({
    retry: {
      backoffCoefficient: 2,
      initialInterval: '2s',
      maximumAttempts: 3,
      maximumInterval: '30s',
    },
    startToCloseTimeout: '30s',
  });

// Workflow generation: an LLM activity (generate→validate→repair) + a DB write.
// Generous timeout; one attempt only (the activity has its own internal repair
// loop, and it is best-effort — it returns null rather than throwing on failure).
const { createChannelWorkflowDraft } = proxyActivities<
  Pick<typeof activitiesType, 'createChannelWorkflowDraft'>
>({
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: '6m',
});

const CHANNEL_ERROR_TEXT =
  ":warning: Sorry, I hit an error working on that and couldn't finish. Please try again.";

// Posted when a `generateWorkflow` intent couldn't produce a valid draft.
const CHANNEL_WORKFLOW_DRAFT_FAILED_TEXT =
  ":warning: I couldn't turn that into a valid workflow. Try describing it with more " +
  'detail — which steps or agents should run, and in what order.';

// Phase A: posted instead of launching a task when the channel is over budget.
const CHANNEL_TASK_BUDGET_TEXT =
  ':moneybag: This channel has reached its monthly assistant budget, so I can ' +
  'not start that task right now. An admin can raise the cap in the dashboard.';

// Phase B: prepended to the ack when a `code` task couldn't resolve a repo, so the
// general (non-code) fallback isn't silent — the user knows no repo was found and
// is told how to fix it.
const CHANNEL_CODE_NO_REPO_NOTE =
  ":information_source: I couldn't find a repository to open a PR against for this " +
  'channel, so I am working on it as a general task instead. Name the repo (or have ' +
  'an admin link one to this channel) for a code/PR run.\n\n';

// Posted (instead of the agent's ack) when a task was already launched in this
// thread — the per-thread task run is single-use (REJECT_DUPLICATE), so a fresh
// task needs its own thread; an in-flight task is steered by replying in-thread.
const CHANNEL_TASK_ALREADY_RUNNING_TEXT =
  ":information_source: I've already taken on a task in this thread. Reply here to " +
  'steer it while it runs, or start a new thread to kick off a separate task.';

export async function ChannelAssistantWorkflow(input: ChannelAssistantTurnInput): Promise<void> {
  // 0. Create the run record FIRST (keyed to this Temporal workflowId) so the
  //    turn's agent traces resolve a runId and persist. Best-effort: a failure
  //    here must not block the user's reply — traces are observability, not the
  //    product. We still try to finalize at the end.
  const workflowId = workflowInfo().workflowId;
  try {
    await startChannelRun({
      channelId: input.channelId,
      kind: 'mention',
      label: input.slackChannelId,
      orgId: input.orgId,
      teamId: input.teamId,
      // Gap J (audit): capture who asked + what, so the per-channel audit view
      // can show "who asked what, when, and what it touched".
      userSlackId: input.userSlackId,
      userText: input.userText,
      workflowId,
    });
  } catch (err) {
    log.warn('ChannelAssistantWorkflow: startChannelRun failed; traces may not persist', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let runStatus: 'SUCCESS' | 'FAILED' = 'SUCCESS';
  try {
    runStatus = await runTurn(input);
  } catch {
    // runTurn only rethrows when even the fallback delivery failed.
    runStatus = 'FAILED';
  } finally {
    // Persistent live session (Gap H): mark this thread as freshly active so a
    // plain follow-up reply (no re-@mention) can continue the conversation while
    // the session window is open. Only on a delivered turn; best-effort.
    if (runStatus === 'SUCCESS') {
      try {
        await touchChannelThreadSession({
          channelId: input.channelId,
          threadTs: input.threadTs,
        });
      } catch (err) {
        log.warn('ChannelAssistantWorkflow: touchChannelThreadSession failed', {
          channelId: input.channelId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Finalize the run record with the terminal status + summed trace cost/tokens.
    // Best-effort; a finalize failure must not surface to the user.
    try {
      await finalizeChannelRun({ status: runStatus, workflowId });
    } catch (err) {
      log.warn('ChannelAssistantWorkflow: finalizeChannelRun failed', {
        channelId: input.channelId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The turn itself: post a placeholder, run the LLM turn, deliver the reply (or a
 * friendly error). Extracted so the run-record lifecycle can wrap it cleanly.
 * Returns the terminal run status — `'FAILED'` when the LLM turn threw (even
 * though we still delivered a friendly fallback to the user), `'SUCCESS'`
 * otherwise. Throws only when even the fallback delivery fails.
 */
async function runTurn(input: ChannelAssistantTurnInput): Promise<'SUCCESS' | 'FAILED'> {
  // 1. Post a placeholder into the thread immediately so the user sees the
  //    teammate "working". Best-effort: if it fails or returns no ts, we fall
  //    back to a fresh reply message below (placeholderTs stays null).
  let placeholderTs: string | null = null;
  try {
    const placeholder = await postChannelPlaceholder({
      slackChannelId: input.slackChannelId,
      threadTs: input.threadTs,
    });
    placeholderTs = placeholder.ts;
  } catch (err) {
    log.warn('ChannelAssistantWorkflow: placeholder post failed; will post a fresh reply', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Run the LLM turn, then 3. deliver the reply: edit the placeholder in place
  //    when we have its ts, otherwise post a fresh message. On error, do the same
  //    with friendly error text (preserving the graceful-fallback behavior).
  try {
    const { reply, delegate, generate } = await runChannelAssistantTurn(input);

    // The agent asked to draft a reusable workflow. Generate + persist a DRAFT
    // template scoped to the channel's team, then tell the user (instead of the
    // agent's ack). The draft lands in the Workflow library for review/activation.
    if (generate) {
      // Generation is an LLM-heavy activity (≤3 model calls) — gate it on the
      // channel budget exactly like a delegated task, so an over-budget channel
      // can't be driven to burn spend by repeated "create a workflow" asks.
      const overBudget = await isChannelOverBudgetForTask(input.channelId);
      if (overBudget) {
        await deliver(input, placeholderTs, CHANNEL_TASK_BUDGET_TEXT);
        return 'SUCCESS';
      }
      const draft = await createChannelWorkflowDraft({
        channelId: input.channelId,
        description: generate.description,
        name: generate.name,
        teamId: input.teamId,
      });
      const text = draft
        ? `:sparkles: I drafted a workflow *"${draft.name}"* for you.` +
          `${draft.summary ? ` ${draft.summary}` : ''}` +
          '\nReview and activate it in the *Workflow library* on the dashboard before running it.'
        : CHANNEL_WORKFLOW_DRAFT_FAILED_TEXT;
      await deliver(input, placeholderTs, text);
      return 'SUCCESS';
    }

    // Phase A: the agent asked to launch a durable task. Gate on the channel
    // budget, then start a thread-bound RunnableWorkflow that works the task and
    // reports its result back in this thread. We DO NOT await the child — the
    // task must outlive this short turn (abandon close policy).
    let replyPrefix = '';
    if (delegate) {
      const overBudget = await isChannelOverBudgetForTask(input.channelId);
      if (overBudget) {
        // Over budget: don't launch; tell the user instead of the agent's ack.
        await deliver(input, placeholderTs, CHANNEL_TASK_BUDGET_TEXT);
        return 'SUCCESS';
      }
      const outcome = await launchTask(input, delegate);
      // A thread already hosts a task (the per-thread workflowId was used). Post an
      // honest message INSTEAD of the agent's "on it" ack — nothing new launched.
      if (outcome.alreadyRunning) {
        await deliver(input, placeholderTs, CHANNEL_TASK_ALREADY_RUNNING_TEXT);
        return 'SUCCESS';
      }
      // Otherwise prepend any routing note (e.g. the code→general no-repo fallback).
      replyPrefix = outcome.prefix;
    }

    // Always post the agent's reply (the "on it" ack when it delegated), prefixed
    // with any routing note (e.g. the code→general no-repo fallback note).
    await deliver(input, placeholderTs, `${replyPrefix}${reply}`);
    return 'SUCCESS';
  } catch (err) {
    log.error('ChannelAssistantWorkflow failed; posting fallback to thread', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
    // Don't leave the user hanging. Best-effort: if even this fails, let the
    // error surface so the run is recorded as failed (the outer catch maps it).
    await deliver(input, placeholderTs, CHANNEL_ERROR_TEXT);
    // We recovered (the fallback was delivered) but the turn itself failed —
    // record the run as FAILED for observability.
    return 'FAILED';
  }
}

/**
 * Deliver `text` to the thread: edit the placeholder in place (chat.update) when
 * we have its ts, otherwise post a fresh reply message.
 */
async function deliver(
  input: ChannelAssistantTurnInput,
  placeholderTs: string | null,
  text: string
): Promise<void> {
  if (placeholderTs) {
    await updateChannelReply({ slackChannelId: input.slackChannelId, text, ts: placeholderTs });
  } else {
    await postChannelReply({
      slackChannelId: input.slackChannelId,
      text,
      threadTs: input.threadTs,
    });
  }
}

/** Prepared child-launch parameters shared by both task routes. */
interface PreparedTaskRun {
  workflowId: string;
  templateId: string;
  templateVersion: number;
  request: RepoWorkRequest;
  /** Gap D: present only when the task is deferred to a valid future time. */
  runAt?: string;
}

/** Outcome of a task launch attempt (drives what the caller posts to the thread). */
interface LaunchOutcome {
  /** Text to PREPEND to the agent's ack — empty, or the code→general fallback note. */
  prefix: string;
  /**
   * True when the per-thread workflowId was already used (`REJECT_DUPLICATE`), so
   * nothing new launched. The caller posts {@link CHANNEL_TASK_ALREADY_RUNNING_TEXT}
   * instead of the agent's "on it" ack rather than falsely claiming a launch.
   */
  alreadyRunning?: boolean;
}

/**
 * Launch a durable, thread-bound task run from a delegate intent.
 *
 * Routing (Phase A + Phase B):
 *  - `route: 'code'` → try the SWE route: resolve the channel's repo + the team's
 *    default SWE template (`createChannelCodeTaskRun`). If a repo resolves, launch
 *    the real implement → review → PR workflow against it. If NO repo resolves
 *    (ambiguous / none), FALL BACK to the general Channel Task route and return a
 *    note so the ack tells the user it answered generally (not silent).
 *  - `route: 'general'` (or the code fallback) → launch the repo-less Channel Task
 *    spec (`createChannelTaskRun`).
 *
 * Both routes share {@link startTaskChild} (ABANDON + REJECT_DUPLICATE +
 * deterministic per-thread workflowId). The per-thread id is single-use: the run
 * record (`WorkflowRun`) is upserted by workflowId, so a second task reusing it
 * would silently operate on the first (closed) run's row. REJECT_DUPLICATE prevents
 * that — a second delegate in a thread surfaces `alreadyRunning` and the caller
 * tells the user to steer the existing task or open a new thread (rather than a
 * false "on it"). Other launch errors are swallowed so they never break the ack.
 */
async function launchTask(
  input: ChannelAssistantTurnInput,
  delegate: DelegateIntent
): Promise<LaunchOutcome> {
  try {
    if (delegate.route === 'code') {
      // Phase B: try the real SWE workflow against the channel's resolved repo.
      const prepared = await createChannelCodeTaskRun({
        channelId: input.channelId,
        description: delegate.description,
        repoHint: delegate.repoHint,
        runAt: delegate.runAt,
        slackChannelId: input.slackChannelId,
        threadTs: input.threadTs,
        title: delegate.title,
      });
      if (prepared) {
        await startTaskChild(prepared);
        return { prefix: '' };
      }
      // No (unambiguous) repo resolved — fall back to the general route and note it.
      log.info('ChannelAssistantWorkflow: code task fell back to general route (no repo)', {
        channelId: input.channelId,
        repoHint: delegate.repoHint,
        title: delegate.title,
      });
      await startTaskChild(await prepareGeneralTaskRun(input, delegate));
      return { prefix: CHANNEL_CODE_NO_REPO_NOTE };
    }

    // General route.
    await startTaskChild(await prepareGeneralTaskRun(input, delegate));
    return { prefix: '' };
  } catch (err) {
    // A second task in a thread reuses the per-thread workflowId → Temporal rejects
    // it with WorkflowExecutionAlreadyStartedError. Surface that so the caller posts
    // an honest "already taken on a task here" note instead of a false ack.
    if (err instanceof Error && err.name === 'WorkflowExecutionAlreadyStartedError') {
      log.info('ChannelAssistantWorkflow: thread already hosts a task run; not relaunching', {
        channelId: input.channelId,
        threadTs: input.threadTs,
      });
      return { alreadyRunning: true, prefix: '' };
    }
    // Any other launch failure is best-effort: don't break the ack we still post.
    log.warn('ChannelAssistantWorkflow: task launch failed; ack still delivered', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { prefix: '' };
  }
}

/** Prepare the repo-less general Channel Task run (Phase A spec). */
async function prepareGeneralTaskRun(
  input: ChannelAssistantTurnInput,
  delegate: DelegateIntent
): Promise<PreparedTaskRun> {
  return createChannelTaskRun({
    channelId: input.channelId,
    description: delegate.description,
    runAt: delegate.runAt,
    slackChannelId: input.slackChannelId,
    threadTs: input.threadTs,
    title: delegate.title,
  });
}

/**
 * Start the prepared task run, immediately or deferred. Shared by both the general
 * and code routes.
 *
 *  - `PARENT_CLOSE_POLICY_ABANDON` + NO `await handle.result()` — the task run
 *    must OUTLIVE this short ChannelAssistantWorkflow turn (the turn finishes as
 *    soon as the ack is posted; the task may run for minutes — or hours, when
 *    deferred).
 *  - `REJECT_DUPLICATE` reuse policy on the deterministic per-thread workflowId.
 *    The id is single-use: the `WorkflowRun` record is upserted by workflowId
 *    (`update: {}`), so reusing the id for a second task — even after the first
 *    CLOSES — would resolve the FIRST run's row and silently misattribute the
 *    second task's traces/cost/title to the closed run. REJECT_DUPLICATE blocks
 *    that; `launchTask` turns the rejection into an honest "already a task in this
 *    thread" message. (A second delegate while the first is still RUNNING never
 *    reaches here — the gateway steers it instead.)
 *
 * Gap D (deferred): when `prepared.runAt` is set, the SAME per-thread workflowId
 * hosts a `ChannelScheduledTaskWorkflow` wrapper that sleeps until `runAt` and then
 * starts the `RunnableWorkflow`. Because it shares the per-thread id under
 * REJECT_DUPLICATE, an immediate and a deferred task in one thread are mutually
 * exclusive — exactly like two immediate tasks — so neither can be silently lost.
 */
async function startTaskChild(prepared: PreparedTaskRun): Promise<void> {
  const { workflowId, templateId, templateVersion, request, runAt } = prepared;
  // Deferred: a ChannelScheduledTaskWorkflow wrapper holds the per-thread id and
  // sleeps until runAt. Immediate: RunnableWorkflow runs under it directly. Both
  // share the per-thread id under REJECT_DUPLICATE, so the two are mutually
  // exclusive — `launchTask` turns a rejection into an honest "already a task
  // here" message rather than a silent clobber.
  if (runAt) {
    await startThreadTaskChild(
      'ChannelScheduledTaskWorkflow',
      [{ request, runAt, templateId, templateVersion }],
      workflowId
    );
    return;
  }
  await startThreadTaskChild(
    'RunnableWorkflow',
    [{ request, templateId, templateVersion }],
    workflowId
  );
}
