/**
 * The three runs the landing page's signal panel plays.
 *
 * Each is a built-in template simplified for a panel: bookkeeping steps are folded
 * into the station they serve, and no step or gate is invented. Unlike the use-case
 * pages these are written by hand, so `heroRoutes.test.mjs` holds them to the specs:
 * a route has exactly as many gates as its template has places a person acts, each
 * gate's `timeout` is one of the spec's own, and any duration the copy mentions is a
 * gate's timeout. Change a template's people or timeouts and that test fails until
 * this file follows.
 *
 * Plain data, imported by `SignalPanel.astro` and by the test.
 */

const UNITS = { d: ['day', 'days'], h: ['hour', 'hours'], m: ['minute', 'minutes'] };

/** A spec timeout as words: `7d` → `7 days`, `24h` → `24 hours`. */
export function formatTimeout(timeout) {
  const match = /^(\d+)([dhm])$/.exec(timeout);
  if (!match) {
    throw new Error(`Unsupported timeout "${timeout}" — extend formatTimeout`);
  }
  const n = Number(match[1]);
  const [one, many] = UNITS[match[2]];
  return `${n} ${n === 1 ? one : many}`;
}

export const HERO_ROUTES = [
  {
    done: 'Run complete. What it learned is stored for the next run on this repository.',
    id: 'ticket',
    note: 'On GitHub, this signal is the merge webhook: a person merges there, and the run hears it.',
    stations: [
      { detail: 'From the dashboard, Slack, the CLI, or the REST API', label: 'Work request' },
      { detail: 'Checks the ticket and recalls lessons from this repository', label: 'Context' },
      { detail: 'In an isolated Docker sandbox, until the tests pass', label: 'Implement' },
      { detail: 'Security, domain-logic, and performance reviewers', label: 'Review network' },
      { detail: 'Opened on a branch of your repository', label: 'Pull request' },
      { detail: 'Failures are read from the logs and fixed', label: 'CI' },
      {
        gate: {
          action: 'Merge the pull request',
          held: 'Held at the signal. A person merges — the agent never does.',
          timeout: '7d',
        },
        label: 'Merge',
      },
      { detail: 'Embedded for the next run', label: 'Lesson stored' },
    ],
    tab: 'Ticket to pull request',
    template: 'default-engineering',
  },
  {
    done: 'Run complete. The reply is on the ticket, and the approval is in the audit log.',
    id: 'support',
    note: 'A seeded template: the connector and agents exist, but only the engineering flow is exercised end to end.',
    stations: [
      { detail: 'From Zendesk', label: 'Ticket read' },
      { detail: 'By the support responder agent', label: 'Reply drafted' },
      { detail: "Your team's autonomy policy decides", label: 'Policy check' },
      {
        gate: {
          action: 'Approve the reply',
          held: 'Held at the signal. Under the default policy, a public reply needs a person.',
          timeout: '24h',
        },
        label: 'Approval',
      },
      { detail: 'Written back to the ticket', label: 'Reply posted' },
    ],
    tab: 'Support reply',
    template: 'zendesk-ticket-reply',
  },
  {
    done: 'Run complete. Two people signed off on a change that had already passed CI.',
    id: 'four-eyes',
    note: 'Two approvals in sequence, each with its own 24-hour window, on the green pull request.',
    stations: [
      { detail: 'From the dashboard, Slack, the CLI, or the REST API', label: 'Work request' },
      { detail: 'In an isolated Docker sandbox, until the tests pass', label: 'Implement' },
      { detail: 'Agent review loop, up to three attempts', label: 'Review network' },
      {
        detail: 'Opened, then CI; the agent fixes a failing check',
        label: 'Pull request and CI',
      },
      {
        detail: 'Author or team lead',
        gate: {
          action: 'Sign off as team lead',
          held: 'Held at the first signal. The author or a team lead signs off.',
          timeout: '24h',
        },
        label: 'First sign-off',
      },
      {
        detail: 'Someone independent',
        gate: {
          action: 'Sign off as second reviewer',
          held: 'Held at the second signal. An independent reviewer signs off.',
          timeout: '24h',
        },
        label: 'Second sign-off',
      },
      {
        detail: 'Asked only if a sign-off is rejected',
        gate: {
          action: 'Say what should change',
          held: 'Held at the question a rejection asks. The reviewer says what should change.',
          timeout: '1h',
        },
        label: 'If rejected',
      },
    ],
    tab: 'Four-eyes change',
    template: 'four-eyes',
  },
];

/**
 * A station's second line. A gate with no hand-written detail shows its timeout,
 * formatted from the same value the test checks against the spec.
 */
export function stationDetail(station) {
  if (station.detail) {
    return station.detail;
  }
  return `Up to ${formatTimeout(station.gate.timeout)}`;
}
