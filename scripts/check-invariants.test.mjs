import { describe, expect, it } from 'vitest';
import { optInSuiteViolations } from './check-invariants.mjs';

const PG = 'packages/gateway/src/routes/x.pg.test.ts';
const DOCKER = 'packages/worker/src/agents/y.docker.test.ts';
const gated = (flag) => `const enabled = process.env.${flag} === '1';\n`;

/** A one-job `ci.yml` whose steps are the given `[name, env, run, extra]` tuples. */
function ci(steps) {
  const body = steps
    .map(([name, env, run, extra = '']) => {
      const envBlock = env ? `        env:\n          ${env}\n` : '';
      return `      - name: ${name}\n${extra}${envBlock}        run: ${run}\n`;
    })
    .join('\n');
  return `jobs:\n  t:\n    steps:\n${body}`;
}

describe('optInSuiteViolations', () => {
  it('passes a database and a Docker suite each run with its flag set', () => {
    const yml = ci([
      ['pg', "PG_FLAG: '1'", `yarn test ${PG}`],
      ['docker', "DOCKER_FLAG: '1'", `yarn test ${DOCKER}`],
    ]);
    const suites = [
      { path: PG, src: gated('PG_FLAG') },
      { path: DOCKER, src: gated('DOCKER_FLAG') },
    ];
    expect(optInSuiteViolations(suites, yml)).toEqual([]);
  });

  it('reports a Docker suite no step runs', () => {
    const v = optInSuiteViolations([{ path: DOCKER, src: gated('DOCKER_FLAG') }], ci([]));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: DOCKER, invariant: 'opt-in-suites-run-in-ci' });
    expect(v[0].detail).toContain('not run by any');
  });

  it('reports a Docker suite run under the wrong flag', () => {
    const yml = ci([['docker', "OTHER_FLAG: '1'", `yarn test ${DOCKER}`]]);
    const v = optInSuiteViolations([{ path: DOCKER, src: gated('DOCKER_FLAG') }], yml);
    expect(v.map((x) => x.detail)).toEqual([
      `the step running ${DOCKER} does not set DOCKER_FLAG: '1'`,
    ]);
  });

  it('reports a Docker suite on a conditional or non-failing step', () => {
    for (const extra of [
      "        if: github.event_name == 'push'\n",
      '        continue-on-error: true\n',
    ]) {
      const yml = ci([['docker', "DOCKER_FLAG: '1'", `yarn test ${DOCKER}`, extra]]);
      const v = optInSuiteViolations([{ path: DOCKER, src: gated('DOCKER_FLAG') }], yml);
      expect(v.map((x) => x.detail)).toEqual([
        `the step running ${DOCKER} has \`if:\` or \`continue-on-error:\``,
      ]);
    }
  });

  it('refuses a suite whose gate is not the recognised form', () => {
    const yml = ci([['docker', "DOCKER_FLAG: '1'", `yarn test ${DOCKER}`]]);
    const src = 'const enabled = Boolean(process.env.DOCKER_FLAG);\n';
    const v = optInSuiteViolations([{ path: DOCKER, src }], yml);
    expect(v[0].detail).toContain('cannot find the suite');
  });

  it('ignores a suite named only in a comment', () => {
    const yml = ci([['docker', "DOCKER_FLAG: '1'", `echo skip # yarn test ${DOCKER}`]]).replace(
      `run: echo skip # yarn test ${DOCKER}`,
      `run: echo skip\n        # yarn test ${DOCKER}`
    );
    const v = optInSuiteViolations([{ path: DOCKER, src: gated('DOCKER_FLAG') }], yml);
    expect(v[0].detail).toContain('not run by any');
  });
});
