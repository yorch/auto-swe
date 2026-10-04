// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewSkill } from '@/hooks/useSkillSources';
import { ApiError } from '@/lib/api';

const SHA = 'c'.repeat(40);

const { create, previewFn, readFn } = vi.hoisted(() => ({
  create: vi.fn(),
  previewFn: vi.fn(),
  readFn: vi.fn(),
}));
vi.mock('@/hooks/useSkillSources', () => ({
  useCreateSource: () => ({ isPending: false, mutateAsync: create }),
  usePreviewSource: () => ({ isPending: false, mutateAsync: previewFn }),
  useReadPreviewSkill: () => ({ isPending: false, mutateAsync: readFn }),
}));
vi.mock('@/hooks/useTeams', () => ({
  useTeams: () => ({ data: [{ id: 'team-1', name: 'Payments' }] }),
}));

const { AddSourceModal, unselectableReason } = await import('./AddSourceModal');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const skill = (name: string | null, over: Partial<PreviewSkill> = {}): PreviewSkill => ({
  blockedByScan: false,
  conflicts: [],
  description: `${name} description`,
  errors: [],
  folder: `skills/${name}`,
  ignoredKeys: [],
  installable: true,
  name,
  referenceFileCount: 0,
  scanWarnings: [],
  skippedFiles: [],
  textLength: 120,
  ...over,
});

const preview = (skills: PreviewSkill[]) => ({
  location: { host: 'github.com', owner: 'acme', path: 'skills', ref: 'main', repo: 'pack' },
  sha: SHA,
  skills,
});

const ALL = [
  skill('good'),
  skill('broken', {
    errors: ['SKILL.md has no YAML frontmatter'],
    installable: false,
  }),
  skill('taken', {
    conflicts: [{ id: 'k1', name: 'taken', scope: 'TEAM' }],
    installable: false,
  }),
  skill('warned', { blockedByScan: true, installable: false, scanWarnings: ['injection:x'] }),
  skill('rich', {
    ignoredKeys: ['allowed-tools'],
    referenceFileCount: 2,
    skippedFiles: [{ path: 'run.sh', reason: 'not-text' }],
  }),
  skill('ev‮il'),
];

async function open() {
  render(<AddSourceModal onClose={() => {}} open />);
  fireEvent.change(screen.getByLabelText(/^Owner/), { target: { value: 'acme' } });
  fireEvent.change(screen.getByLabelText(/^Repository/), { target: { value: 'pack' } });
  fireEvent.change(screen.getByLabelText(/^Path/), { target: { value: 'skills' } });
  fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Preview' }));
  await screen.findByText('Choose skills to install');
}

const read = async (name: string) => {
  fireEvent.click(screen.getByLabelText(`Read full text of ${name}`));
  await screen.findByLabelText(`Full text of ${name}`);
};
const box = (name: string) => screen.getByLabelText(`Install ${name}`) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  previewFn.mockResolvedValue(preview(ALL));
  create.mockResolvedValue({ skills: [] });
  readFn.mockImplementation(async ({ skill }: { skill: string }) => ({
    description: null,
    errors: [],
    folder: `skills/${skill}`,
    name: skill,
    promptText: `FULL ${skill}`,
    referenceFiles: [],
    sha: SHA,
  }));
});

describe('AddSourceModal', () => {
  it('previews with the form values (nothing else is called) and defaults to GLOBAL, text only', async () => {
    await open();
    expect(previewFn).toHaveBeenCalledWith({
      host: 'github.com',
      owner: 'acme',
      path: 'skills',
      ref: 'main',
      repo: 'pack',
      scope: 'GLOBAL',
      scriptMode: 'TEXT_ONLY',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('shows name, description, length, warnings, conflicts, errors, skipped files and ignored keys', async () => {
    await open();
    expect(screen.getByText('SKILL.md has no YAML frontmatter', { exact: false })).toBeTruthy();
    expect(screen.getByText('name already used by a TEAM skill')).toBeTruthy();
    expect(screen.getByText('scan: injection:x')).toBeTruthy();
    expect(screen.getByText('skipped 1 file(s): run.sh (not-text)')).toBeTruthy();
    expect(screen.getByText('ignored frontmatter: allowed-tools')).toBeTruthy();
    expect(screen.getByText('2 reference file(s) kept')).toBeTruthy();
    expect(screen.getAllByText('120').length).toBeGreaterThan(0);
    expect(screen.getByText('good description')).toBeTruthy();
    expect(screen.getByText(/@ ccccccc/)).toBeTruthy();
  });

  it('cannot select a skill with errors, a conflict, or blocking scan warnings', async () => {
    await open();
    // A clean skill is still not selectable until its full text has been read.
    expect(box('good').disabled).toBe(true);
    await read('good');
    await read('rich');
    expect(box('good').disabled).toBe(false);
    expect(box('rich').disabled).toBe(false);
    expect(screen.queryByLabelText('Read full text of broken')).toBeNull();
    expect(box('broken').disabled).toBe(true);
    expect(box('taken').disabled).toBe(true);
    expect(box('warned').disabled).toBe(true);
  });

  it('a skill with warnings is selectable when the setting does not block them', () => {
    expect(
      unselectableReason(skill('w', { blockedByScan: false, scanWarnings: ['x'] }))
    ).toBeNull();
    expect(unselectableReason(skill('w', { blockedByScan: true, installable: false }))).toMatch(
      /blockOnScanWarnings/
    );
    expect(unselectableReason(skill(null, { errors: ['bad'], installable: false }))).toBe(
      'has errors'
    );
  });

  it('shows hidden characters in names', async () => {
    await open();
    expect(screen.getByText('ev⟨U+202E⟩il')).toBeTruthy();
  });

  it('creates with the chosen names and the previewed sha', async () => {
    await open();
    await read('good');
    await read('rich');
    fireEvent.click(box('good'));
    fireEvent.click(box('rich'));
    fireEvent.click(screen.getByText('Install 2 skills'));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        host: 'github.com',
        owner: 'acme',
        path: 'skills',
        ref: 'main',
        repo: 'pack',
        scope: 'GLOBAL',
        scriptMode: 'TEXT_ONLY',
        sha: SHA,
        skills: ['good', 'rich'],
      })
    );
  });

  it('needs a chosen skill before it can install', async () => {
    await open();
    const submit = screen.getByText('Install 0 skills').closest('button') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('409 SHA_MOVED asks for a re-preview, and re-previewing reads the repository again', async () => {
    create.mockRejectedValueOnce(
      new ApiError('The repository moved', 409, 'SKILL_SOURCE_SHA_MOVED')
    );
    await open();
    await read('good');
    fireEvent.click(box('good'));
    fireEvent.click(screen.getByText('Install 1 skill'));
    expect(await screen.findByText(/changed since the preview/)).toBeTruthy();
    fireEvent.click(screen.getByText('Preview again'));
    await waitFor(() => expect(previewFn).toHaveBeenCalledTimes(2));
  });

  it('409 NAME_CONFLICT lists the names', async () => {
    create.mockRejectedValueOnce(
      new ApiError('conflict', 409, 'SKILL_IMPORT_NAME_CONFLICT', [
        { existingId: 'k', name: 'go​od', scope: 'GLOBAL' },
      ])
    );
    await open();
    await read('good');
    fireEvent.click(box('good'));
    fireEvent.click(screen.getByText('Install 1 skill'));
    expect(await screen.findByText('These names are already taken', { exact: false })).toBeTruthy();
    expect(screen.getByText('go⟨U+200B⟩od: already exists (GLOBAL scope)')).toBeTruthy();
  });

  it('422 lists the reasons', async () => {
    create.mockRejectedValueOnce(
      new ApiError('Some chosen skills drew scanner warnings', 422, 'SKILL_IMPORT_SCAN_WARNINGS', [
        { name: 'good', warnings: ['exfil:curl'] },
      ])
    );
    await open();
    await read('good');
    fireEvent.click(box('good'));
    fireEvent.click(screen.getByText('Install 1 skill'));
    expect(await screen.findByText(/drew scanner warnings/)).toBeTruthy();
    expect(screen.getByText('good: exfil:curl')).toBeTruthy();
  });

  it('shows a failed preview with the gateway message and stays on the form', async () => {
    previewFn.mockRejectedValueOnce(
      new ApiError('Repository not found', 404, 'SKILL_SOURCE_NOT_FOUND')
    );
    render(<AddSourceModal onClose={() => {}} open />);
    fireEvent.change(screen.getByLabelText(/^Owner/), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText(/^Repository/), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Preview' }));
    expect(await screen.findByText(/Repository not found/)).toBeTruthy();
    expect(screen.queryByText('Choose skills to install')).toBeNull();
  });

  it('reads the full text with the form values and the skill name, and shows it with hidden characters visible', async () => {
    readFn.mockResolvedValueOnce({
      description: null,
      errors: [],
      folder: 'skills/good',
      name: 'good',
      promptText: 'one\nhid \u202e den',
      referenceFiles: [],
      sha: SHA,
    });
    await open();
    await read('good');
    expect(readFn).toHaveBeenCalledWith({
      host: 'github.com',
      owner: 'acme',
      path: 'skills',
      ref: 'main',
      repo: 'pack',
      scope: 'GLOBAL',
      scriptMode: 'TEXT_ONLY',
      skill: 'good',
    });
    const panel = screen.getByLabelText('Full text of good');
    expect(panel.textContent).toBe('one\nhid ⟨U+202E⟩ den');
    expect(panel.className).toContain('overflow-auto');
    expect(screen.getByText(/one full fetch of the repository/)).toBeTruthy();
  });

  it('a text read at another commit than the preview does not unlock the skill', async () => {
    readFn.mockResolvedValueOnce({
      description: null,
      errors: [],
      folder: 'skills/good',
      name: 'good',
      promptText: 'x',
      referenceFiles: [],
      sha: 'd'.repeat(40),
    });
    await open();
    fireEvent.click(screen.getByLabelText('Read full text of good'));
    expect(await screen.findByText(/changed since the preview/)).toBeTruthy();
    expect(box('good').disabled).toBe(true);
    expect(screen.queryByLabelText('Full text of good')).toBeNull();
  });

  it('previewing again discards the texts read', async () => {
    create.mockRejectedValueOnce(new ApiError('moved', 409, 'SKILL_SOURCE_SHA_MOVED'));
    await open();
    await read('good');
    fireEvent.click(box('good'));
    fireEvent.click(screen.getByText('Install 1 skill'));
    fireEvent.click(await screen.findByText('Preview again'));
    await waitFor(() => expect(previewFn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByLabelText('Full text of good')).toBeNull());
    expect(box('good').disabled).toBe(true);
  });
});
