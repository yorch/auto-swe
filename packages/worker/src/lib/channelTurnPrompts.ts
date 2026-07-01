/**
 * Channel-assistant turn prompt notes — the inline system-prompt suffixes appended
 * to a channel assistant turn (NOT standalone agent personas, which live in
 * `@auto-swe/shared/lib/agentPrompts`). Each note is a behavioural hint tied to a
 * turn-time tool (`delegateTask`, `generateWorkflow`) or the Gap H follow-up intent
 * gate; `runChannelAssistantTurn` concatenates them into the turn's `promptNote`.
 *
 * Co-located here (worker-local, same package as the turn builder + the tools they
 * describe) rather than in `shared/agentPrompts`: they are suffix fragments that are
 * meaningless without the surrounding turn, not reused or overridable.
 */

/**
 * `delegateTask` tool note: tells the agent to launch a durable background task for
 * genuine multi-step work (vs. answering inline for quick questions), and how to set
 * `route` / `repoHint` / `runAt`.
 */
export const DELEGATE_TOOL_PROMPT_NOTE = [
  '',
  'You have a `delegateTask` tool. Use it ONLY when the user is asking you to ',
  'carry out a genuine multi-step task (e.g. "investigate X and summarise", ',
  '"draft the migration plan", "build Y") rather than answer a quick question. ',
  'When you call it, a durable background run is launched that works the task ',
  'and reports back in this thread — so your own reply should be a brief ',
  'acknowledgement ("On it — I\'ll follow up here."). For quick questions, just ',
  'answer directly and do NOT call the tool. Set route="code" only when the task ',
  'requires editing a repository / opening a pull request; otherwise route="general". ',
  'For a code task, if the user named a specific repository, pass it as `repoHint` ',
  '(e.g. "payments-api" or "acme/payments-api"); leave it unset if no repo was named. ',
  'If the user explicitly asks to defer the task to a specific future time (e.g. ',
  '"tomorrow at 9am", "next Monday", "in 2 hours"), pass an ISO 8601 UTC timestamp as ',
  '`runAt` (e.g. "2026-06-26T09:00:00Z"). Leave `runAt` unset for immediate execution.',
].join('');

/**
 * `generateWorkflow` tool note: tells the agent to use it when the user wants to
 * CREATE a reusable workflow/automation (a saved template), not run a one-off task
 * (`delegateTask`) or answer a question.
 */
export const GENERATE_WORKFLOW_TOOL_PROMPT_NOTE = [
  '',
  'You also have a `generateWorkflow` tool. Use it ONLY when the user asks you to ',
  'CREATE / SET UP a reusable workflow, automation, or pipeline (a saved template ',
  'they can run repeatedly) — e.g. "create a workflow that runs the implementer then ',
  'opens a PR", "set up an automation for…". This generates the workflow and saves it ',
  'as a DRAFT for a human to review and activate; your own reply should briefly say so ',
  '("I\'ve drafted that workflow — review and activate it in the Workflow library."). ',
  'Do NOT use it for a one-off task (use `delegateTask`) or a quick question.',
].join('');

/**
 * Gap H intent gate: appended ONLY for a follow-up continuation turn (a plain thread
 * reply, no re-`@mention`). Tells the agent to stay out of a conversation that isn't
 * directed at it, using the SKIP convention the ambient/reactive paths use so the
 * workflow can suppress the reply.
 */
export const FOLLOWUP_INTENT_PROMPT_NOTE = [
  '',
  'You are continuing a thread you were recently active in, WITHOUT being directly ',
  '@mentioned again. Only respond if the latest message is plausibly addressed to ',
  'you (a follow-up question to you, or something you can clearly help with). If the ',
  'teammates are talking among themselves and the latest message is NOT for you, do ',
  'NOT butt in — reply with exactly: SKIP',
].join('');
