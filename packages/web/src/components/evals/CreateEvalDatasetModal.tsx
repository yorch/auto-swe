'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { type CreateEvalCaseInput, useCreateEvalDataset } from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';

// Limits mirror `CreateDatasetBody` / `CaseInput` in gateway `routes/evals.ts`.
const SLUG_RE = /^[a-z0-9_-]+$/;
const MAX_TAGS = 50;
const MAX_TAG_LEN = 100;

type Stack = NonNullable<CreateEvalCaseInput['stack']>;
const STACK_OPTIONS = [
  { label: 'Default image (no stack)', value: '' },
  { label: 'node', value: 'node' },
  { label: 'python', value: 'python' },
  { label: 'jvm', value: 'jvm' },
  { label: 'go', value: 'go' },
];

interface CaseDraft {
  key: number;
  baselineSha: string;
  goldenTest: string;
  input: string;
  reference: string;
  repoUrl: string;
  stack: '' | Stack;
  tags: string;
}

let nextKey = 0;
function blankCase(): CaseDraft {
  nextKey += 1;
  return {
    baselineSha: '',
    goldenTest: '',
    input: '',
    key: nextKey,
    reference: '',
    repoUrl: '',
    stack: '',
    tags: '',
  };
}

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/** What is wrong with a case, in the schema's terms; null when it would be accepted. */
function caseProblem(c: CaseDraft): string | null {
  if (c.input.trim() === '') {
    return 'Add the task prompt.';
  }
  if (c.repoUrl.trim() === '' || c.repoUrl.length > 2000) {
    return 'Add the repository URL (up to 2000 characters).';
  }
  if (c.baselineSha.trim() === '' || c.baselineSha.length > 200) {
    return 'Add the baseline commit (up to 200 characters).';
  }
  if (c.goldenTest.trim() === '' || c.goldenTest.length > 4000) {
    return 'Add the golden test command (up to 4000 characters).';
  }
  const tags = parseTags(c.tags);
  if (tags.length > MAX_TAGS || tags.some((t) => t.length > MAX_TAG_LEN)) {
    return `At most ${MAX_TAGS} tags, each up to ${MAX_TAG_LEN} characters.`;
  }
  return null;
}

/**
 * Creates a global dataset and its cases in one request. The API sets a dataset's cases only when
 * the dataset is created, so this is the one place cases are entered.
 */
export function CreateEvalDatasetModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const router = useRouter();
  const create = useCreateEvalDataset();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [cases, setCases] = useState<CaseDraft[]>(() => [blankCase()]);
  const [error, setError] = useState<string | null>(null);

  const slugOk = SLUG_RE.test(slug) && slug.length <= 100;
  const problems = cases.map(caseProblem);
  const canSave = name.trim() !== '' && name.length <= 200 && slugOk && description.length <= 2000;
  const casesOk = problems.every((p) => p === null);

  const patch = (key: number, change: Partial<CaseDraft>) =>
    setCases((rows) => rows.map((r) => (r.key === key ? { ...r, ...change } : r)));

  return (
    <Modal
      dismissible={!create.isPending}
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Created at the global scope. Cases are set now and cannot be added to the dataset later."
      title="New eval dataset"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!casesOk) {
            return;
          }
          setError(null);
          create.mutate(
            {
              cases: cases.map((c) => {
                const tags = parseTags(c.tags);
                return {
                  baselineSha: c.baselineSha.trim(),
                  goldenTest: c.goldenTest,
                  input: c.input,
                  ...(c.reference.trim() !== '' ? { reference: c.reference } : {}),
                  repoUrl: c.repoUrl.trim(),
                  stack: c.stack === '' ? null : c.stack,
                  ...(tags.length > 0 ? { tags } : {}),
                };
              }),
              description: description.trim() === '' ? null : description.trim(),
              name: name.trim(),
              slug,
            },
            {
              onError: (err) => setError(errMsg(err, 'The dataset could not be created')),
              onSuccess: (dataset) => {
                setName('');
                setSlug('');
                setDescription('');
                setCases([blankCase()]);
                onClose();
                router.push(`/admin/evals/datasets/${dataset.id}`);
              },
            }
          );
        }}
      >
        <Input
          label="Name"
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          required
          value={name}
        />
        <Input
          error={slug !== '' && !slugOk ? 'Lowercase letters, digits, - and _ only.' : undefined}
          hint="Names the dataset to `auto-swe evals run`."
          label="Slug"
          maxLength={100}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="payments-regressions"
          required
          value={slug}
        />
        <Textarea
          label="Description"
          maxLength={2000}
          mono={false}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          value={description}
        />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-paper-100">
              Cases <span className="text-paper-500 tabular-nums">({cases.length})</span>
            </h3>
            <Button
              onClick={() => setCases((rows) => [...rows, blankCase()])}
              size="sm"
              type="button"
              variant="secondary"
            >
              Add case
            </Button>
          </div>
          <p className="text-xs text-paper-500">
            A new case is checked for stability before it is scored. A dataset may also be created
            with no cases.
          </p>
          {cases.map((c, i) => {
            const n = i + 1;
            return (
              <fieldset className="space-y-3 rounded-md border border-ink-600 p-3" key={c.key}>
                <legend className="px-1 text-xs font-medium text-paper-300">Case {n}</legend>
                <Textarea
                  hint="The task the implementer is given."
                  label={`Prompt (case ${n})`}
                  mono={false}
                  onChange={(e) => patch(c.key, { input: e.target.value })}
                  required
                  rows={3}
                  value={c.input}
                />
                <Input
                  label={`Repository URL (case ${n})`}
                  maxLength={2000}
                  onChange={(e) => patch(c.key, { repoUrl: e.target.value })}
                  required
                  value={c.repoUrl}
                />
                <Input
                  hint="The commit the case starts from."
                  label={`Baseline commit (case ${n})`}
                  maxLength={200}
                  onChange={(e) => patch(c.key, { baselineSha: e.target.value })}
                  required
                  value={c.baselineSha}
                />
                <Textarea
                  hint="Run in the workspace; its exit code is the score."
                  label={`Golden test (case ${n})`}
                  maxLength={4000}
                  onChange={(e) => patch(c.key, { goldenTest: e.target.value })}
                  required
                  rows={2}
                  value={c.goldenTest}
                />
                <Textarea
                  hint="Optional expected outcome (expected tests, golden diff, ideal answer), stored as text."
                  label={`Expectations (case ${n})`}
                  mono={false}
                  onChange={(e) => patch(c.key, { reference: e.target.value })}
                  rows={2}
                  value={c.reference}
                />
                <Select
                  hint="The toolchain image the golden test runs in."
                  label={`Stack (case ${n})`}
                  onChange={(v) => patch(c.key, { stack: (v || '') as CaseDraft['stack'] })}
                  options={STACK_OPTIONS}
                  value={c.stack}
                />
                <Input
                  hint="Comma-separated. Optional."
                  label={`Tags (case ${n})`}
                  onChange={(e) => patch(c.key, { tags: e.target.value })}
                  value={c.tags}
                />
                {problems[i] && (
                  <p className="text-xs text-danger-400">
                    Case {n}: {problems[i]}
                  </p>
                )}
                <Button
                  onClick={() => setCases((rows) => rows.filter((r) => r.key !== c.key))}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {`Remove case ${n}`}
                </Button>
              </fieldset>
            );
          })}
        </div>

        {error && <Alert variant="error">{error}</Alert>}
        <ModalFooter
          disabled={!canSave || !casesOk}
          isPending={create.isPending}
          onCancel={onClose}
          pendingLabel="Creating…"
          submitLabel="Create dataset"
        />
      </form>
    </Modal>
  );
}
