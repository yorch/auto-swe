'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  type RecallArmOutcomes,
  type RecallRateDifference,
  useLessonRecallExperiment,
} from '@/hooks/useLessons';

const percent = (value: number | null) =>
  value === null ? 'Unknown' : `${(100 * value).toFixed(1)}%`;

function Outcomes({ arms }: { arms: Partial<Record<'ON' | 'SHADOW' | 'OFF', RecallArmOutcomes>> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {[
              'Arm',
              'Runs',
              'Held out',
              'Success',
              'Failure',
              'Merge',
              'Gate pass',
              'Mean fix iterations',
              'Mean cost',
            ].map((heading) => (
              <th className="px-3 py-2" key={heading} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(arms).map(([arm, values]) => (
            <tr key={arm}>
              <th className="px-3 py-2" scope="row">
                {arm}
              </th>
              <td className="px-3 py-2">{values.runCount}</td>
              <td className="px-3 py-2">{values.heldOutCount}</td>
              <td className="px-3 py-2">
                {percent(values.successRate)} (n={values.outcomeKnownCount})
              </td>
              <td className="px-3 py-2">
                {percent(values.failureRate)} (n={values.outcomeKnownCount})
              </td>
              <td className="px-3 py-2">
                {percent(values.mergeRate)} (n={values.mergeKnownCount})
              </td>
              <td className="px-3 py-2">
                {percent(values.gatePassRate)} (n={values.gateKnownCount})
              </td>
              <td className="px-3 py-2">{values.meanFixLoopIterations?.toFixed(2) ?? 'Unknown'}</td>
              <td className="px-3 py-2">
                {values.meanCostUsd === null ? 'Unknown' : `$${values.meanCostUsd.toFixed(4)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Difference({ label, value }: { label: string; value: RecallRateDifference | null }) {
  const points = (rate: number) => (100 * rate).toFixed(1);
  return (
    <p className="text-sm">
      {label} ON − SHADOW:{' '}
      {value
        ? `${points(value.difference)} percentage points (95% CI ${points(value.lower95)} to ${points(value.upper95)})`
        : 'not estimable (missing known outcomes in an arm)'}
    </p>
  );
}

/** The parent supplies only repositories the caller manages. The API checks authority again. */
export function LessonRecallExperiment({
  repositories,
}: {
  repositories: { id: string; organizationName: string | null; repoName: string | null }[];
}) {
  const [selected, setSelected] = useState('');
  const [since, setSince] = useState(() =>
    new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  );
  const repoId = repositories.find((repo) => repo.id === selected)?.id ?? repositories[0]?.id;
  const query = useLessonRecallExperiment(repoId, since);
  const data = query.data;
  if (!repoId) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Lesson recall outcome comparison</CardTitle>
      </CardHeader>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-4">
          <Select
            label="Comparison repository"
            onChange={setSelected}
            options={repositories.map((repo) => ({
              label: `${repo.organizationName}/${repo.repoName}`,
              value: repo.id,
            }))}
            value={repoId}
          />
          <Input
            label="Runs started since"
            onChange={(event) => setSince(event.target.value)}
            type="date"
            value={since}
          />
        </div>
        {query.isLoading && <p>Loading recall outcomes…</p>}
        {query.error && <Alert>Cannot load recall outcomes: {query.error.message}</Alert>}
        {data && (
          <>
            <p className="text-sm text-paper-400">{data.caveat}</p>
            {(data.comparison.smallSample || data.likeForLike.comparison.smallSample) && (
              <Alert variant="warning">{data.smallSampleWarning}</Alert>
            )}
            <h3 className="font-semibold">All completed runs with an assigned arm</h3>
            <Outcomes arms={data.arms} />
            <Difference label="Success rate" value={data.comparison.successRateDifference} />
            <Difference label="Merge rate" value={data.comparison.mergeRateDifference} />
            <Difference label="Gate pass rate" value={data.comparison.gatePassRateDifference} />
            <h3 className="font-semibold">Like-for-like: at least one lesson matched</h3>
            <p className="text-sm text-paper-400">
              ON received lessons; SHADOW would have received lessons. This is a retrieval-match
              subset, not proof of model use.
            </p>
            <Outcomes arms={{ ON: data.likeForLike.ON, SHADOW: data.likeForLike.SHADOW }} />
            <Difference
              label="Matched success rate"
              value={data.likeForLike.comparison.successRateDifference}
            />
            <Difference
              label="Matched merge rate"
              value={data.likeForLike.comparison.mergeRateDifference}
            />
            <Difference
              label="Matched gate pass rate"
              value={data.likeForLike.comparison.gatePassRateDifference}
            />
            <p className="text-sm text-paper-400">
              n counts known outcomes. Cancelled/skipped runs are not success/failure labels. Gates
              use the latest result per scorer; fix iterations count started engineering fix-step
              attempts. Missing merge evidence is unknown, not failure.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
