import type { PullRequestCockpit } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { safeHttpUrl } from '@/lib/safeUrl';
import { plural } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';

type Evaluation = NonNullable<PullRequestCockpit['evaluation']>;

/** Ticket and model text, so plain text with its hidden characters made visible; never markup. */
const text = (value: string) => visibleText(value, { multiline: true });

const CI_WORDS: Record<NonNullable<Evaluation['evidence']>['ci'] & string, string> = {
  failed: 'failed',
  none: 'no checks ran',
  passed: 'passed',
  pending: 'still running',
};

function Heading({ children }: { children: string }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-paper-400">
      {children}
    </h3>
  );
}

function testsSentence(tests: NonNullable<Evaluation['evidence']>['tests']): string {
  if (tests === null) {
    return 'Tests: no result recorded for this head.';
  }
  if (tests.total === 0) {
    return 'Tests: none ran at this head.';
  }
  return `Tests: ${tests.passing} passing, ${tests.failing} failing at this head.`;
}

function uiSentence(ui: NonNullable<NonNullable<Evaluation['evidence']>['ui']>): string {
  const parts = [
    ui.screenshots > 0 ? plural(ui.screenshots, 'screenshot') : null,
    ui.videos > 0 ? plural(ui.videos, 'video') : null,
    ui.traces > 0 ? plural(ui.traces, 'trace') : null,
  ].filter((part) => part !== null);
  return `Browser checks the run captured: ${parts.length > 0 ? parts.join(', ') : 'none'}.`;
}

function Evidence({
  evidence,
  pull,
}: {
  evidence: NonNullable<Evaluation['evidence']>;
  pull: PullRequestCockpit['pull'];
}) {
  const runUrl = safeHttpUrl(evidence.runUrl);
  return (
    <section>
      <Heading>What the run verified</Heading>
      <ul className="list-disc space-y-1 pl-5 text-sm text-paper-200">
        <li>{testsSentence(evidence.tests)}</li>
        {evidence.ui ? <li>{uiSentence(evidence.ui)}</li> : null}
        <li>
          CI when this was evaluated:{' '}
          {evidence.ci === null ? 'could not be read' : CI_WORDS[evidence.ci]}.
        </li>
        {pull.latestRun ? (
          <li>
            <Link className="text-accent-400 hover:underline" href={`/runs/${pull.latestRun.id}`}>
              The run
            </Link>{' '}
            has its full trace.
          </li>
        ) : runUrl ? (
          <li>
            <a
              className="text-accent-400 hover:underline"
              href={runUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              The run
            </a>{' '}
            has its full trace.
          </li>
        ) : null}
      </ul>
      <p className="mt-2 text-xs text-paper-500">
        Not checked here: whether the tests cover what was asked.
      </p>
    </section>
  );
}

function Intent({ intent }: { intent: NonNullable<Evaluation['intent']> }) {
  if (intent.criteria.length === 0 && intent.openQuestions.length === 0) {
    return null;
  }
  const settled = new Map(intent.handled.map((h) => [h.question, h]));
  return (
    <>
      {intent.criteria.length > 0 ? (
        <section>
          <Heading>What was asked</Heading>
          <ul className="list-disc space-y-1 pl-5 text-sm text-paper-200">
            {intent.criteria.map((criterion) => (
              <li key={criterion}>{text(criterion)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {intent.openQuestions.length > 0 ? (
        <section>
          <Heading>Open questions</Heading>
          <ul className="list-disc space-y-1 pl-5 text-sm text-paper-200">
            {intent.openQuestions.map((question) => {
              const handled = settled.get(question);
              return (
                <li key={question}>
                  {text(question)}
                  {handled ? (
                    <span className="block text-xs text-paper-400">
                      The run says it{' '}
                      {handled.resolution === 'implemented'
                        ? `implemented this: ${text(handled.note)}`
                        : `left this unchanged${handled.note ? `: ${text(handled.note)}` : ''}`}
                      . That is its own account, not checked.
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/**
 * What the evaluation recorded about the pull request, as the stored data gives it: the ticket's
 * intent, what the run verified, why it has this risk class, and what to verify. Nothing here
 * reads the host, and a part an older evaluation did not store is left out.
 */
export function ReviewBrief({
  evaluation,
  pull,
}: {
  evaluation: Evaluation | null;
  pull: PullRequestCockpit['pull'];
}) {
  if (evaluation === null) {
    return (
      <Alert announce={false} variant="info">
        This pull request has not been evaluated, so there is no brief for it yet.
      </Alert>
    );
  }
  const reasons = evaluation.reasons.filter((r) => r.severity !== 'info');
  const empty =
    evaluation.intent === null &&
    evaluation.evidence === null &&
    reasons.length === 0 &&
    evaluation.claimsToVerify.length === 0;
  if (empty) {
    return null;
  }
  return (
    <Card className="space-y-5 p-5" variant="inset">
      {evaluation.intent ? <Intent intent={evaluation.intent} /> : null}
      {evaluation.evidence ? <Evidence evidence={evaluation.evidence} pull={pull} /> : null}
      {reasons.length > 0 ? (
        <section>
          <Heading>Why this risk class</Heading>
          <ul className="list-disc space-y-1 pl-5 text-sm text-paper-200">
            {reasons.map((reason) => (
              <li key={`${reason.code}:${reason.message}`}>{text(reason.message)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {evaluation.claimsToVerify.length > 0 ? (
        <section>
          <Heading>To verify</Heading>
          <ul className="list-disc space-y-1 pl-5 text-sm text-paper-200">
            {evaluation.claimsToVerify.map((claim) => (
              <li key={claim}>{text(claim)}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}
