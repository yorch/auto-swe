'use client';

import { MAX_SCAN_TEXT_LENGTH, MAX_TEST_SAMPLES } from '@auto-swe/shared/lib/regexSafety';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Textarea } from '@/components/ui/Textarea';
import { type ScannerTestResult, useTestScannerPattern } from '@/hooks/useTestScannerPattern';
import { errMsg } from '@/lib/errors';
import type { ScannerPatternType } from '@/lib/scannerPatternTypes';

/** The gateway's bounds on a test request (routes/scannerPatterns.ts), from the same shared source. */
export { MAX_TEST_SAMPLES };
export const MAX_TEST_SAMPLE_LENGTH = MAX_SCAN_TEXT_LENGTH;

/**
 * What one sample stands for in each category, from what each scanner runs the pattern on. A
 * sample is sent as one piece of text, newlines intact, and the executor runs the pattern on it
 * as a single target, so `^`/`$` need the `m` flag and `.` needs `s` to cross a line, as in a
 * real scan.
 */
export const SAMPLE_HINT: Record<ScannerPatternType, string> = {
  CODE_SECURITY:
    'The scanner tests each added line of a diff on its own, so use one added line per sample (without the leading +); a multi-line sample is tested as one piece of text, which the scanner never does.',
  EXFILTRATION:
    'A sample stands for skill content or LLM output; the scanner tests that text as one piece, so a multi-line sample is tested the same way.',
  INJECTION:
    'A sample stands for text such as skill content, LLM output, a memory item or a CI log; a multi-line sample is tested as one piece of text.',
  PII: 'The scanner tests an eval node output as one piece of text, which may span several lines, so a multi-line sample is tested the same way; an output that is not a string is tested as its one-line JSON text.',
  SENSITIVE_FILE: 'A sample stands for one file path the agent would write.',
  SHELL_COMMAND:
    'A sample stands for a bash command, which may span several lines. The scanner splits a command at ; & and | and also checks its whitespace-collapsed, continuation-joined spelling; the tester runs the text as written.',
};

/** The samples that are sent: non-blank fields, with their 1-based field number, text untouched. */
export function sampleEntries(fields: readonly { text: string }[]) {
  return fields
    .map((f, i) => ({ number: i + 1, text: f.text }))
    .filter((f) => f.text.trim() !== '');
}

/** First line of a sample, with a note when more follow. */
function previewOf(text: string): string {
  const lines = text.split('\n');
  const at = Math.max(
    0,
    lines.findIndex((l) => l.trim() !== '')
  );
  const first = lines[at] ?? '';
  const extra = lines.length - at - 1;
  return extra > 0 ? `${first} (+${extra} more ${extra === 1 ? 'line' : 'lines'})` : first;
}

function Outcome({
  number,
  result,
  sample,
}: {
  number: number;
  result: ScannerTestResult;
  sample: string;
}) {
  return (
    <li className="space-y-1 rounded-md border border-ink-600 bg-ink-900/50 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {result.status === 'matched' && <Badge tone="amber">Matched</Badge>}
        {result.status === 'no_match' && <Badge tone="muted">No match</Badge>}
        {result.status === 'timed_out' && <Badge tone="brick">Timed out</Badge>}
        {result.status === 'error' && <Badge tone="brick">Error</Badge>}
        {result.status === 'not_run' && <Badge tone="muted">Skipped</Badge>}
        <span className="text-xs font-medium text-paper-200">Sample {number}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-paper-400">
          {previewOf(sample)}
        </code>
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

interface Field {
  id: number;
  text: string;
}

type FocusTarget = { kind: 'field'; id: number } | { kind: 'add' };

const fmt = (n: number) => n.toLocaleString('en-US');

function summarise(results: readonly ScannerTestResult[]): string {
  const count = (status: ScannerTestResult['status']) =>
    results.filter((r) => r.status === status).length;
  const unevaluated = results.length - count('matched') - count('no_match');
  const parts = [`${count('matched')} matched`, `${count('no_match')} no match`];
  if (unevaluated > 0) {
    parts.push(`${unevaluated} not evaluated (timed out, failed or skipped)`);
  }
  return `${results.length} ${results.length === 1 ? 'sample' : 'samples'} tested: ${parts.join(', ')}.`;
}

/**
 * A collapsible "try it" area for a pattern being viewed or edited. The check runs on the
 * gateway through the scanners' own time-limited executor and saves nothing. Each sample is its
 * own field and may span several lines; it is sent as one piece of text, newlines intact.
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
  const [fields, setFields] = useState<Field[]>([{ id: 0, text: '' }]);
  const nextId = useRef(1);
  const [sent, setSent] = useState<{ number: number; text: string }[]>([]);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const test = useTestScannerPattern();
  const { reset } = test;

  const fieldDomId = (id: number) => `${idPrefix}-tester-sample-${id}`;
  const addId = `${idPrefix}-tester-add`;
  const maxNoteId = `${idPrefix}-tester-max`;

  // Results describe the pattern that produced them; drop them once it changes.
  const lastKey = useRef(`${pattern}\u0000${flags}`);
  useEffect(() => {
    const key = `${pattern}\u0000${flags}`;
    if (lastKey.current !== key) {
      lastKey.current = key;
      reset();
    }
  }, [pattern, flags, reset]);

  // Move focus once the DOM has the element it names, so focus is never left on a removed node.
  useEffect(() => {
    if (!focusTarget) {
      return;
    }
    const id =
      focusTarget.kind === 'add'
        ? `${idPrefix}-tester-add`
        : `${idPrefix}-tester-sample-${focusTarget.id}`;
    document.getElementById(id)?.focus();
    setFocusTarget(null);
  }, [focusTarget, idPrefix]);

  const entries = sampleEntries(fields);
  const atMax = fields.length >= MAX_TEST_SAMPLES;
  const tooLong = entries.some((e) => e.text.length > MAX_TEST_SAMPLE_LENGTH);
  const problem = tooLong
    ? `Each sample can be at most ${fmt(MAX_TEST_SAMPLE_LENGTH)} characters.`
    : undefined;
  const canRun = pattern !== '' && entries.length > 0 && !problem && !test.isPending;
  const results = sent.length > 0 ? test.data : undefined;
  const panelId = `${idPrefix}-tester-panel`;

  // Adding or removing a field renumbers the samples, so results labelled with the old numbers
  // would name the wrong field; they are dropped and the test is run again.
  function discardResults() {
    setSent([]);
    reset();
  }

  function addField() {
    if (atMax) {
      return;
    }
    const id = nextId.current++;
    discardResults();
    setFields((f) => [...f, { id, text: '' }]);
    setFocusTarget({ id, kind: 'field' });
  }

  function removeField(index: number) {
    if (fields.length <= 1) {
      return;
    }
    const next = fields.filter((_, i) => i !== index);
    discardResults();
    setFields(next);
    // The field that slides into this position, else the one before it.
    const neighbour = next[index] ?? next[index - 1];
    setFocusTarget(neighbour ? { id: neighbour.id, kind: 'field' } : { kind: 'add' });
  }

  function run() {
    setSent(entries);
    test.mutate({ flags, pattern, samples: entries.map((e) => e.text) });
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
            {SAMPLE_HINT[type]} A scanner may adjust the text before matching, so a miss here does
            not prove the scanner would miss it. A sample may span several lines: with the{' '}
            <code>m</code> flag <code>^</code> and <code>$</code> match at each line, and with{' '}
            <code>s</code> the dot crosses a line break.
          </p>
          <div className="space-y-3">
            {fields.map((field, index) => {
              const over = field.text.length - MAX_TEST_SAMPLE_LENGTH;
              return (
                <div className="space-y-1.5" key={field.id}>
                  <Textarea
                    compact
                    error={
                      over > 0
                        ? `${fmt(over)} characters over the ${fmt(MAX_TEST_SAMPLE_LENGTH)} character limit.`
                        : undefined
                    }
                    hint={`${fmt(field.text.length)} of ${fmt(MAX_TEST_SAMPLE_LENGTH)} characters.`}
                    id={fieldDomId(field.id)}
                    label={`Sample ${index + 1}`}
                    onChange={(e) =>
                      setFields((fs) =>
                        fs.map((f) => (f.id === field.id ? { ...f, text: e.target.value } : f))
                      )
                    }
                    rows={3}
                    value={field.text}
                  />
                  <Button
                    disabled={fields.length <= 1}
                    onClick={() => removeField(index)}
                    size="sm"
                    variant="ghost"
                  >
                    Remove sample {index + 1}
                  </Button>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              aria-describedby={atMax ? maxNoteId : undefined}
              disabled={atMax}
              id={addId}
              onClick={addField}
              size="sm"
              variant="ghost"
            >
              Add sample
            </Button>
            {atMax && (
              <span className="text-xs text-paper-400" id={maxNoteId}>
                {MAX_TEST_SAMPLES} samples is the most that can be tested at once.
              </span>
            )}
          </div>
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
          <p aria-live="polite" className="text-xs text-paper-300">
            {results ? summarise(results.results) : ''}
          </p>
          {results && (
            <div className="space-y-2">
              <p className="text-xs text-paper-500">
                Time limit per sample: {results.budgetMs} ms. Only the first match in each sample is
                shown.
              </p>
              <ul className="space-y-2">
                {results.results.map((r) => (
                  <Outcome
                    key={r.index}
                    number={sent[r.index]?.number ?? r.index + 1}
                    result={r}
                    sample={sent[r.index]?.text ?? ''}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
