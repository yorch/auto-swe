import {
  CHANNEL_TASK_STEER_SIGNAL,
  channelTaskExternalTicketId,
  channelTaskWorkflowId,
} from '@auto-swe/shared/lib/channelTask';
import {
  type RepoAccessGate,
  resolveRepoAccessGateOrLastKnown,
} from '@auto-swe/shared/lib/repoAccessGate';
import { decideSlackRepoAccessWithGate } from '@auto-swe/shared/lib/slackRepoAccess';
import { resolveSlackBotTokenForSlackChannel } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance } from 'fastify';
import { postSlackMessage } from '../slack.js';
import { isTerminalSignalError } from '../temporalErrors.js';

/** Gap H: how long after the assistant's last reply a plain follow-up (no
 *  re-@mention) still continues the conversation. Self-limiting so the bot never
 *  re-engages stale threads. */
const SESSION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Persistent live session (Gap H): is the assistant "live" in this thread right
 * now? True when a `ChannelThreadSession` exists for `(channelId, threadTs)` and
 * its `lastAssistantAt` is within {@link SESSION_WINDOW_MS}. Best-effort: any DB
 * error resolves to `false` (fail closed — never start an unexpected turn).
 */
export async function isLiveThreadSession(
  fastify: FastifyInstance,
  channelId: string,
  threadTs: string
): Promise<boolean> {
  try {
    const session = await fastify.prisma.channelThreadSession.findUnique({
      select: { lastAssistantAt: true },
      where: { channelId_threadTs: { channelId, threadTs } },
    });
    if (!session) {
      return false;
    }
    return Date.now() - session.lastAssistantAt.getTime() < SESSION_WINDOW_MS;
  } catch (err) {
    fastify.log.warn({ channelId, err, threadTs }, 'isLiveThreadSession lookup failed');
    return false;
  }
}

/**
 * May this person redirect the task running in this thread?
 *
 * A steer is not a smaller thing than a launch. The text is appended to the
 * instructions an agent is executing against a repository — and for a DEFERRED
 * task it is spliced into the run's description before the run has started at
 * all, so it is indistinguishable from having asked for that work in the first
 * place. Gating the launch and leaving the steer open would mean anyone who can
 * type in the channel can write the second half of an authorized user's task.
 *
 * The check is repository access, not authorship. Two teammates who both have
 * write access steering each other's task is ordinary collaboration, and the
 * gate exists to describe who may reach the repository, not who owns a thread.
 *
 * **A refusal is silent here, and deliberately so.** Returning false falls
 * through to the caller's normal handling: a plain thread reply is dropped as
 * channel chatter always is, and an `@mention` starts a turn whose code route
 * refuses in the thread with a message that says what to do about it. Answering
 * every unsteered reply directly would turn the bot into a thing that talks back
 * at conversations it is not part of, and would confirm that a task is running
 * in the thread to someone who may not be entitled to know it.
 *
 * ### Which repository the thread is judged against
 *
 * Two properties are needed of that lookup, and neither is obvious.
 *
 * **The key must be one no caller can write.** `externalTicketId` looks like
 * the natural join — the channel task files itself under a deterministic
 * `slack-<channel>-<thread>` — but it is a free-text field taken straight from
 * the body of `POST /work-requests` and `POST /epics`, and its validation
 * permits every character that id uses. Keyed on it alone, anyone could submit
 * an ordinary work request against a repository they legitimately hold, under
 * the victim thread's ticket id, and have this decide against *their* repository
 * instead. So the query also requires the two typed Slack columns and the
 * channel-task payload marker, none of which any API route writes — only
 * `buildChannelTaskRun` sets all of them. The ticket id stays in the `where` for
 * its index, where it can narrow but can no longer decide.
 *
 * **Every repository the thread has tasked must pass, not the newest one.** A
 * `RunInput` is written before the child run is started, so a thread accumulates
 * rows: a task that lost the already-running race leaves one behind, and so does
 * a repo-less general task in a thread that already has a code task. Taking the
 * most recent row would let either mask the repository actually being steered —
 * including one planted deliberately, by asking for a code task with a
 * `repoHint` naming a repository the asker *can* reach. Requiring all of them
 * makes those rows monotonic: an extra row can only ever narrow who may steer,
 * so planting one denies the planter rather than promoting them. That property
 * is why the repository id is read from the payload as well as the column — see
 * {@link taskRepoId}, where removing a row from the set is the failure being
 * guarded against.
 */
async function maySteerThreadTask(
  fastify: FastifyInstance,
  slackChannelId: string,
  threadTs: string,
  userSlackId: string | undefined,
  gate: RepoAccessGate
): Promise<boolean> {
  let repoIds: string[];
  try {
    const tasks = await fastify.prisma.runInput.findMany({
      select: { connectionId: true, payload: true },
      // One more than the cap, so a result AT the cap is distinguishable from
      // one that was truncated. Truncation has to fail closed: the rows this
      // dropped are exactly the ones an attacker would want dropped.
      take: STEER_ROW_SCAN_LIMIT + 1,
      where: {
        externalTicketId: channelTaskExternalTicketId(slackChannelId, threadTs),
        payload: { equals: 'channel-task', path: ['kind'] },
        slackChannelId,
        slackMessageTs: threadTs,
      },
    });
    if (tasks.length > STEER_ROW_SCAN_LIMIT) {
      fastify.log.warn(
        { slackChannelId, threadTs },
        'refusing to steer channel task: more task rows in this thread than the decision scans'
      );
      return false;
    }
    // Distinct repositories, counted AFTER the dedupe. Counting rows would
    // refuse an ordinary thread: every turn that delegates writes a row, a
    // repo-less general task writes one too, and all of them normally name the
    // same single repository — so a busy thread would silently lose steering
    // for everyone, in every mode, for a reason no message explains.
    repoIds = [...new Set(tasks.map(taskRepoId).filter((id) => id !== null))];
    if (repoIds.length > STEER_REPO_SCAN_LIMIT) {
      fastify.log.warn(
        { repoCount: repoIds.length, slackChannelId, threadTs },
        'refusing to steer channel task: more repositories in this thread than the decision scans'
      );
      return false;
    }
  } catch (err) {
    // Fail closed. This runs only to decide whether to hand someone's text to a
    // running agent, and a lookup that did not answer cannot say they may.
    fastify.log.warn({ err, slackChannelId, threadTs }, 'steer access lookup failed');
    return false;
  }
  // No code task has ever run in this thread. Nothing to gate: the general route
  // is untouched in every mode — it answers questions and needs no identity to
  // do so, which is the same line the code route draws.
  if (repoIds.length === 0) {
    return true;
  }

  for (const repoId of repoIds) {
    const verdict = await decideSlackRepoAccessWithGate(
      fastify.prisma,
      userSlackId,
      repoId,
      gate,
      // Steering redirects a run that `isWorkflowRunning` just confirmed is in
      // flight, so a retired installation does not stop it — retirement stops
      // new work and nothing else.
      'steer-running-work',
      fastify.log
    );
    if (!verdict.allowed) {
      fastify.log.warn(
        { reason: verdict.reason, repoId, slackChannelId, threadTs, userSlackId },
        // Not "has no access": `gate-unreadable` and `repo-unreadable` establish
        // nothing about the requester, and an operator chasing "steering stopped
        // during a config blip" should not be pointed at the person.
        `refusing to steer channel task: ${verdict.reason}`
      );
      return false;
    }
  }
  return true;
}

/**
 * How many distinct repositories one thread's tasks may name before a steer is
 * refused outright. A thread has one running task, so the real number is one;
 * the allowance is for the repositories a thread accumulates over its life, and
 * the ceiling is really about cost — each one is its own live decision.
 */
const STEER_REPO_SCAN_LIMIT = 10;

/**
 * How many task ROWS the lookup will read before refusing.
 *
 * A separate, far looser bound than the repository one, because rows and
 * repositories are not the same quantity: an ordinary thread accumulates a row
 * per delegating turn, all naming one repository. This exists only so the read
 * cannot be unbounded; reaching it means something is wrong with the thread, not
 * with the person steering.
 */
const STEER_ROW_SCAN_LIMIT = 100;

/**
 * The repository a channel task row names, from either place it is recorded.
 *
 * The column is authoritative while it is set, but deleting a `Connection` sets
 * it to null on every row that pointed at it — so reading the column alone would
 * let a repository be *removed* from the set, which is the one thing that must
 * not be possible: the whole reason the set is required rather than ranked is
 * that a row can only narrow it. The payload copy is written at the same moment
 * and no cascade touches it, and the id it holds now resolves to nothing, which
 * the decision fails closed on rather than waving through.
 *
 * Null means a repo-less general task, which names no repository in either
 * place and has nothing to check.
 */
function taskRepoId(task: { connectionId: string | null; payload: unknown }): string | null {
  if (task.connectionId) {
    return task.connectionId;
  }
  const recorded = (task.payload as { repoId?: unknown } | null)?.repoId;
  return typeof recorded === 'string' && recorded.length > 0 ? recorded : null;
}

/**
 * Attempt to steer an in-flight channel task run bound to this thread. The task
 * run's Temporal workflowId is deterministic — `channelTaskWorkflowId(channelId,
 * threadTs)` — so we reconstruct it without a DB lookup and deliver the new
 * guidance via the `steer` signal.
 *
 * Returns `true` only when the signal was delivered (an active run exists and
 * was steered). A `WorkflowNotFoundError` — no run, or the run already
 * closed/terminated — means "nothing to steer here"; we return `false` so the
 * caller falls through to normal handling. On a successful steer we post a tiny
 * best-effort in-thread ack (never fails the steer).
 */
export async function trySteerThreadTask(
  fastify: FastifyInstance,
  channelId: string,
  threadTs: string,
  slackChannelId: string,
  userText: string,
  userSlackId: string | undefined
): Promise<boolean> {
  const workflowId = channelTaskWorkflowId(channelId, threadTs);

  // The mode is read FIRST, and `off` skips the whole apparatus below.
  //
  // Not an optimisation. Everything the gate added has failure modes of its own
  // — a truncated scan, a lookup that did not answer — and each of them refuses.
  // A deployment that never asked for the gate must not lose a steer to a
  // database blip in a check it did not turn on. Reading the mode after building
  // the repository set, inside the decision, left exactly that hole.
  const gate = await resolveRepoAccessGateOrLastKnown();
  if (!gate) {
    // Never readable is not `off`; see `decideSlackRepoAccess`.
    fastify.log.warn(
      { slackChannelId, threadTs },
      'refusing to steer channel task: gate-unreadable'
    );
    return false;
  }
  if (gate.mode !== 'off') {
    // Is there anything here to steer, before deciding whether they may?
    //
    // Signalling first and reading the not-found error is the cheaper order only
    // while the decision is free. It is not: under enforcement it asks GitHub who
    // this person is and what they may do, twice, live. A `RunInput` row is
    // permanent, so without this every reply in a thread that once hosted a code
    // task would pay that for the life of the thread — and most thread replies
    // are people talking to each other, long after the task closed.
    if (!(await fastify.temporal.isWorkflowRunning(workflowId))) {
      return false;
    }
    if (!(await maySteerThreadTask(fastify, slackChannelId, threadTs, userSlackId, gate))) {
      return false;
    }
  }
  try {
    await fastify.temporal.signalWorkflow(workflowId, CHANNEL_TASK_STEER_SIGNAL, [userText]);
  } catch (err) {
    // No active task run in this thread (or it already closed) — fall through.
    if (isTerminalSignalError(err)) {
      return false;
    }
    throw err;
  }

  // Best-effort in-thread ack so the human sees the steer landed. Never let
  // chatter failures undo the (already-delivered) steer.
  try {
    const botToken = await resolveSlackBotTokenForSlackChannel(slackChannelId);
    await postSlackMessage(
      {
        channel: slackChannelId,
        text: ':writing_hand: noted — steering the task.',
        threadTs,
      },
      botToken ?? undefined
    );
  } catch (err) {
    fastify.log.warn(
      { channelId, err, threadTs },
      'steer ack post failed (steer already delivered)'
    );
  }
  return true;
}
