import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Opt in with CODE_REVIEW_DATABASE_URL pointing at a disposable, migrated database.
describe.skipIf(!process.env.CODE_REVIEW_DATABASE_URL)('review persistence constraints', () => {
  const client = new Client({ connectionString: process.env.CODE_REVIEW_DATABASE_URL });
  const templateId = randomUUID();
  const sourceTemplateId = randomUUID();
  const presetId = randomUUID();
  const sourceRunId = randomUUID();
  const reviewRunId = randomUUID();

  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO workflow_templates (id, name, kind) VALUES ($1, 'review', 'review'), ($2, 'source', NULL)`,
      [templateId, sourceTemplateId]
    );
    await client.query(
      `INSERT INTO review_presets (id, name, template_id) VALUES ($1, 'security', $2)`,
      [presetId, templateId]
    );
    await client.query(
      `INSERT INTO workflow_runs (id, workflow_id, template_id, template_version, spec_snapshot)
       VALUES ($1::uuid, $1::text, $3, 1, '{}'), ($2::uuid, $2::text, $3, 1, '{}')`,
      [sourceRunId, reviewRunId, templateId]
    );
  });
  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  it('defaults presets and intents and accepts both template kinds', async () => {
    const preset = await client.query(
      'SELECT on_blocking, enabled FROM review_presets WHERE id = $1',
      [presetId]
    );
    expect(preset.rows).toEqual([{ enabled: true, on_blocking: 'report' }]);
    const intent = await client.query(
      'INSERT INTO review_launch_intents (source_run_id, preset_id) VALUES ($1, $2) RETURNING status, attempts',
      [sourceRunId, presetId]
    );
    expect(intent.rows).toEqual([{ attempts: 0, status: 'pending' }]);
  });

  it.each([
    ['UPDATE workflow_templates SET kind = $1 WHERE id = $2', 'normal', templateId],
    ['UPDATE review_presets SET on_blocking = $1 WHERE id = $2', 'ignore', presetId],
    ['UPDATE review_presets SET template_id = $1 WHERE id = $2', sourceTemplateId, presetId],
  ])('rejects invalid discriminator: %s', async (sql, value, id) => {
    await expect(client.query(sql, [value, id])).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses clearing a preset template kind', async () => {
    await expect(
      client.query('UPDATE workflow_templates SET kind = NULL WHERE id = $1', [templateId])
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('requires a review-kind template on preset insertion', async () => {
    await expect(
      client.query('INSERT INTO review_presets (name, template_id) VALUES ($1, $2)', [
        'bad',
        sourceTemplateId,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });

  it.each([null, randomUUID()])(
    'rejects missing or doubled attachment targets: %s',
    async (repo) => {
      await expect(
        client.query(
          'INSERT INTO review_preset_attachments (preset_id, template_id, connection_id) VALUES ($1, $2, $3)',
          [presetId, repo ? sourceTemplateId : null, repo]
        )
      ).rejects.toMatchObject({ code: '23514' });
    }
  );

  it('deduplicates source-template attachments', async () => {
    const sql = 'INSERT INTO review_preset_attachments (preset_id, template_id) VALUES ($1, $2)';
    await client.query(sql, [presetId, sourceTemplateId]);
    await expect(client.query(sql, [presetId, sourceTemplateId])).rejects.toMatchObject({
      code: '23505',
    });
  });

  it.each([
    ['unknown', 0],
    ['pending', -1],
  ])('rejects invalid intent state %s / %s', async (status, attempts) => {
    await expect(
      client.query(
        'INSERT INTO review_launch_intents (source_run_id, preset_id, status, attempts) VALUES ($1, $2, $3, $4)',
        [sourceRunId, presetId, status, attempts]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('deduplicates automatic launch intents', async () => {
    const sql = 'INSERT INTO review_launch_intents (source_run_id, preset_id) VALUES ($1, $2)';
    await client.query(sql, [sourceRunId, presetId]);
    await expect(client.query(sql, [sourceRunId, presetId])).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('restricts deletion of a preset template', async () => {
    await client.query('DELETE FROM workflow_runs WHERE template_id = $1', [templateId]);
    await expect(
      client.query('DELETE FROM workflow_templates WHERE id = $1', [templateId])
    ).rejects.toMatchObject({ code: '23001', constraint: 'review_presets_template_id_fkey' });
  });

  it('preserves reviews and cascades intents when the source disappears', async () => {
    await client.query(
      'UPDATE workflow_runs SET review_of_run_id = $1, review_preset_id = $2 WHERE id = $3',
      [sourceRunId, presetId, reviewRunId]
    );
    await client.query(
      'INSERT INTO review_launch_intents (source_run_id, preset_id, review_run_id) VALUES ($1, $2, $3)',
      [sourceRunId, presetId, reviewRunId]
    );
    await client.query('DELETE FROM workflow_runs WHERE id = $1', [sourceRunId]);
    expect(
      (
        await client.query('SELECT review_of_run_id FROM workflow_runs WHERE id = $1', [
          reviewRunId,
        ])
      ).rows
    ).toEqual([{ review_of_run_id: null }]);
    expect(
      (
        await client.query('SELECT * FROM review_launch_intents WHERE source_run_id = $1', [
          sourceRunId,
        ])
      ).rows
    ).toEqual([]);
  });

  it('cascades preset attachments and intents but preserves review history', async () => {
    await client.query('UPDATE workflow_runs SET review_preset_id = $1 WHERE id = $2', [
      presetId,
      reviewRunId,
    ]);
    await client.query(
      'INSERT INTO review_preset_attachments (preset_id, template_id) VALUES ($1, $2)',
      [presetId, sourceTemplateId]
    );
    await client.query(
      'INSERT INTO review_launch_intents (source_run_id, preset_id) VALUES ($1, $2)',
      [sourceRunId, presetId]
    );
    await client.query('DELETE FROM review_presets WHERE id = $1', [presetId]);
    expect(
      (
        await client.query('SELECT review_preset_id FROM workflow_runs WHERE id = $1', [
          reviewRunId,
        ])
      ).rows
    ).toEqual([{ review_preset_id: null }]);
    expect(
      (
        await client.query('SELECT * FROM review_preset_attachments WHERE preset_id = $1', [
          presetId,
        ])
      ).rows
    ).toEqual([]);
    expect(
      (await client.query('SELECT * FROM review_launch_intents WHERE preset_id = $1', [presetId]))
        .rows
    ).toEqual([]);
  });
});
