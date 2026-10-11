'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Textarea } from '@/components/ui/Textarea';
import { type ScannerTestResult, useTestScannerPattern } from '@/hooks/useTestScannerPattern';
import { errMsg } from '@/lib/errors';
import type { ScannerPatternType } from '@/lib/scannerPatternTypes';

/** Mirror the gateway's bounds on a test request (routes/scannerPatterns.ts). */
export const MAX_TEST_SAMPLES = 10;
export const MAX_TEST_SAMPLE_LENGTH = 20_000;

/** What one sample stands for in each category, from what each scanner runs the pattern on. */
export const SAMPLE_HINT: Record<ScannerPatternType, string> = {
  CODE_SECURITY: 'Each line stands for an added line of a diff.',
  EXFILTRATION: 'Each line stands for a piece of skill content or LLM output.',
  INJECTION:
    'Each line stands for a piece of text such as skill content, LLM output, a memory item or a CI log.',
  PII: 'The scanner checks an eval node output as a whole, which may span several lines; each line here is tested on its own.',
  SENSITIVE_FILE: 'Each line stands for a file path the agent would write.',
  SHELL_COMMAND: 'Each line stands for a bash command.',
};

/** One sample per non-blank line. */
export function parseSamples(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

function Outcome({ result, sample }: { result: ScannerTestResult; sample: string }) {
  return (
    <li className="space-y-1 rounded-md border border-ink-600 bg-ink-900/50 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {result.status === 'matched' && <Badge tone="amber">Matched</Badge>}
        {result.status === 'no_match' && <Badge tone="muted">No match</Badge>}
        {result.status === 'timed_out' && <Badge tone="brick">Timed out</Badge>}
        {result.status === 'error' && <Badge tone="brick">Error</Badge>}
        {result.status === 'not_run' && <Badge tone="muted">Skipped</Badge>}
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-paper-400">{sample}</code>
      </div>
      {result.status === 'matched' && result.match && (
        <p className="text-xs text-paper-300">
          {result.match.length === 0 ? (
            'Matched an empty string.'
          ) : (
            <>
              First match ({result.match.length} characters
              {result.match.truncated ? ', excerpt shortened' : ''}):{' '}
              <mark className="rounded-sm bg-ember-400/20 px-1 font-mono text-ember-200">
                {result.match.excerpt}
              </mark>
            </>
          )}
        </p>
      )}
      {result.status === 'timed_out' && (
        <p className="text-xs text-brick-400">
          The pattern ran past the time limit on this sample, so it could not be evaluated.
        </p>
      )}
      {result.status === 'error' && (
        <p className="text-xs text-brick-400">
          The check failed before it could finish, so this sample could not be evaluated. This is
          not a verdict on the pattern; try again.
        </p>
      )}
      {result.status === 'not_run' && (
        <p className="text-xs text-paper-400">Skipped: time limit for this test was reached.</p>
      )}
    </li>
  );
}

/**
 * A collapsible "try it" area for a pattern being viewed or edited. The check runs on the
 * gateway through the scanners' own time-limited executor and saves nothing.
 */
export function PatternTester({
  flags,
  idPrefix,
  pattern,
  type,
}: {
  flags: string;
  /** Keeps field ids unique when more than one tester could be mounted. */
  idPrefix: string;
  pattern: string;
  type: ScannerPatternType;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const test = useTestScannerPattern();
  const { reset } = test;

  // Results describe the pattern that produced them; drop them once it changes.
  const lastKey = useRef(`${pattern}\u0000${flags}`);
  useEffect(() => {
    const key = `${pattern}\u0000${flags}`;
    if (lastKey.current !== key) {
      lastKey.current = key;
      reset();
    }
  }, [pattern, flags, reset]);

  const samples = parseSamples(text);
  const tooMany = samples.length > MAX_TEST_SAMPLES;
  const tooLong = samples.some((s) => s.length > MAX_TEST_SAMPLE_LENGTH);
  const problem = tooMany
    ? `At most ${MAX_TEST_SAMPLES} samples (lines) can be tested at once.`
    : tooLong
      ? `Each sample can be at most ${MAX_TEST_SAMPLE_LENGTH.toLocaleString('en-US')} characters.`
      : undefined;
  const canRun = pattern !== '' && samples.length > 0 && !problem && !test.isPending;
  const panelId = `${idPrefix}-tester-panel`;

  function run() {
    setSent(samples);
    test.mutate({ flags, pattern, samples });
  }

  return (
    <div className="rounded-md border border-ink-600">
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-paper-200 hover:text-paper-50"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        Try this pattern
      </button>
      {open && (
        <div className="space-y-3 border-t border-ink-600 p-3" id={panelId}>
          <p className="text-xs leading-relaxed text-paper-400">
            Runs the pattern as written on the server, the way the scanners run it, with a time
            limit. Nothing is saved. The samples are sent to the gateway for the check.{' '}
            {SAMPLE_HINT[type]} A scanner may adjust the text before matching (a shell command is
            checked in several spellings), so a miss here does not prove the scanner would miss it.
          </p>
          <Textarea
            compact
            hint={`One sample per line, up to ${MAX_TEST_SAMPLES}. Blank lines are ignored.`}
            id={`${idPrefix}-tester-samples`}
            label="Sample text"
            onChange={(e) => setText(e.target.value)}
            rows={4}
            value={text}
          />
          {problem && <Alert variant="warning">{problem}</Alert>}
          <div className="flex items-center gap-3">
            <Button disabled={!canRun} onClick={run} size="sm" variant="secondary">
              {test.isPending ? 'Testing…' : 'Test'}
            </Button>
            {pattern === '' && (
              <span className="text-xs text-paper-500">Enter a pattern to test it.</span>
            )}
          </div>
          {test.isError && <Alert>{errMsg(test.error, 'Could not test the pattern')}</Alert>}
          {test.data && (
            <div aria-live="polite" className="space-y-2">
              <p className="text-xs text-paper-500">
                Time limit per sample: {test.data.budgetMs} ms. Only the first match in each sample
                is shown.
              </p>
              <ul className="space-y-2">
                {test.data.results.map((r) => (
                  <Outcome key={r.index} result={r} sample={sent[r.index] ?? ''} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
