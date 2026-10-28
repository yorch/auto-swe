import { describe, expect, it } from 'vitest';
import {
  createFromStdinArgs,
  createPodArgs,
  deletePodArgs,
  deleteSecretArgs,
  execArgs,
  execPrefix,
  secretStdinPreamble,
  tarOutArgs,
} from './kubectlArgs.js';

const ref = { namespace: 'ns', pod: 'workspace-1' };

describe('execArgs', () => {
  it('targets the workspace container and passes the command after --', () => {
    const args = execArgs(ref, ['git', 'status'], { workdir: '/workspace/target-repo' });
    expect(args.slice(0, 7)).toEqual([
      'exec',
      '--namespace',
      'ns',
      '--container',
      'workspace',
      'workspace-1',
      '--',
    ]);
    expect(args.slice(-2)).toEqual(['git', 'status']);
    expect(args).not.toContain('-i');
  });

  it('changes directory through the shell wrapper, not a flag kubectl lacks', () => {
    const args = execArgs(ref, ['ls'], { workdir: '/workspace' });
    expect(args.slice(7)).toEqual(['sh', '-c', 'cd "$0" && exec "$@"', '/workspace', 'ls']);
  });

  it('prefixes non-secret env through env(1)', () => {
    const args = execArgs(ref, ['ls'], { env: ['A=1', 'B=two words'], workdir: '/' });
    expect(args.slice(-4)).toEqual(['env', 'A=1', 'B=two words', 'ls']);
  });

  it('refuses a credential-named env pair without echoing its value', () => {
    const value = 'value-that-must-not-leak';
    const build = () => execArgs(ref, ['ls'], { env: [`DEPLOY_TOKEN=${value}`] });
    expect(build).toThrow(/DEPLOY_TOKEN/);
    expect(build).toThrow(/secretEnv/);
    expect(build).not.toThrow(new RegExp(value));
  });

  it('accepts non-credential env pairs when the exec also carries secrets', () => {
    expect(() => execArgs(ref, ['ls'], { env: ['A=1'], secrets: true })).not.toThrow();
  });

  it('asks for stdin only when it is used', () => {
    expect(execArgs(ref, ['cat'], { interactive: true })).toContain('-i');
    expect(execArgs(ref, ['cat'], {})).not.toContain('-i');
  });

  it('switches to the secret-reading wrapper, which needs stdin', () => {
    const args = execArgs(ref, ['run'], { secrets: true, workdir: '/w' });
    expect(args).toContain('-i');
    expect(args.join(' ')).toContain('read -r asw_l');
  });
});

describe('secretStdinPreamble', () => {
  it('is NAME=value lines closed by a blank line', () => {
    expect(secretStdinPreamble({ A: 'x', B: 'y z' })).toBe('A=x\nB=y z\n\n');
  });

  it('never appears in the exec argv', () => {
    const secret = 'sk-very-secret-value';
    const args = execArgs(ref, ['claude', '--serve'], { env: ['MODE=1'], secrets: true });
    expect(args.join('\u0000')).not.toContain(secret);
    expect(secretStdinPreamble({ ANTHROPIC_API_KEY: secret })).toContain(secret);
  });

  it('refuses names and values the wrapper cannot carry', () => {
    expect(() => secretStdinPreamble({ 'BAD NAME': 'x' })).toThrow(/invalid secret/);
    expect(() => secretStdinPreamble({ '1BAD': 'x' })).toThrow(/invalid secret/);
    expect(() => secretStdinPreamble({ A: 'line\nbreak' })).toThrow(/line break/);
    expect(() => secretStdinPreamble({ A: 'cr\rhere' })).toThrow(/line break/);
    expect(() => secretStdinPreamble({ A: '' })).toThrow(/empty/);
  });

  it('is just the terminator for no secrets', () => {
    expect(secretStdinPreamble({})).toBe('\n');
  });
});

describe('tarOutArgs', () => {
  it('reads a trailing /. as the directory’s contents, like docker cp', () => {
    expect(tarOutArgs('/workspace/target-repo/.')).toEqual([
      'tar',
      'cf',
      '-',
      '-C',
      '/workspace/target-repo',
      '.',
    ]);
  });

  it('archives a single path by its base name', () => {
    expect(tarOutArgs('/workspace/file.txt')).toEqual([
      'tar',
      'cf',
      '-',
      '-C',
      '/workspace',
      'file.txt',
    ]);
  });
});

describe('pod lifecycle argv', () => {
  it('deletes without waiting and tolerates a missing pod', () => {
    const args = deletePodArgs(ref);
    expect(args).toEqual(
      expect.arrayContaining(['--ignore-not-found', '--wait=false', '--grace-period=0', '--force'])
    );
  });

  it('execPrefix marks interactivity', () => {
    expect(execPrefix(ref, true)[1]).toBe('-i');
    expect(execPrefix(ref, false)).not.toContain('-i');
  });
});

describe('secret and pod lifecycle args', () => {
  it('creates from stdin, printing the pod uid only when asked', () => {
    expect(createFromStdinArgs('ns')).toEqual(['create', '--namespace', 'ns', '-f', '-']);
    expect(createPodArgs('ns', false)).toEqual(createFromStdinArgs('ns'));
    expect(createPodArgs('ns', true).slice(-2)).toEqual(['-o', 'jsonpath={.metadata.uid}']);
  });

  it('deletes a secret by name and tolerates a missing one', () => {
    expect(deleteSecretArgs('ns', 'p-env')).toEqual([
      'delete',
      'secret',
      'p-env',
      '--namespace',
      'ns',
      '--ignore-not-found',
    ]);
  });
});
