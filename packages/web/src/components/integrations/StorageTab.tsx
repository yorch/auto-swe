'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import {
  type StorageBackend,
  type StorageConfigInput,
  testStorageConnection,
  useStorageConfig,
  useUpdateStorageConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { ConfigField } from './ConfigField';
import { SecretInput } from './SecretInput';
import { SourceBadge } from './SourceBadge';

export function StorageTab() {
  const { data: resp, isLoading } = useStorageConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateStorageConfig();

  const [backend, setBackend] = useState<StorageBackend>('inline');
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3Region, setS3Region] = useState('');
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [s3Prefix, setS3Prefix] = useState('');
  const [s3ForcePathStyle, setS3ForcePathStyle] = useState(false);
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');

  const { saved, error, testing, testResult, submit, runTest } = useIntegrationConfigForm();

  // Seed form from loaded data (once)
  useEffect(() => {
    if (!data) {
      return;
    }
    setBackend(data.backend ?? 'inline');
    setS3Bucket(data.s3Bucket ?? '');
    setS3Region(data.s3Region ?? '');
    setS3Endpoint(data.s3Endpoint ?? '');
    setS3Prefix(data.s3Prefix ?? '');
    setS3ForcePathStyle(data.s3ForcePathStyle ?? false);
    setAwsAccessKeyId(data.awsAccessKeyId ?? '');
  }, [data]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const body: StorageConfigInput = { backend };
    if (backend === 's3') {
      if (s3Bucket) {
        body.s3Bucket = s3Bucket;
      }
      if (s3Region) {
        body.s3Region = s3Region;
      }
      if (s3Endpoint) {
        body.s3Endpoint = s3Endpoint;
      }
      if (s3Prefix) {
        body.s3Prefix = s3Prefix;
      }
      body.s3ForcePathStyle = s3ForcePathStyle;
      if (awsAccessKeyId) {
        body.awsAccessKeyId = awsAccessKeyId;
      }
      if (awsSecretAccessKey) {
        body.awsSecretAccessKey = awsSecretAccessKey;
      }
    }

    submit(
      () => update.mutateAsync(body),
      () => setAwsSecretAccessKey('')
    );
  };

  const handleTest = () => {
    runTest(() => testStorageConnection());
  };

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Storage">Backend</CardTitle>
        </CardHeader>
        <div className="space-y-3">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              checked={backend === 'inline'}
              className="mt-0.5 accent-ember-400"
              name="storage-backend"
              onChange={() => setBackend('inline')}
              type="radio"
              value="inline"
            />
            <span>
              <span className="text-sm text-paper-100">
                Inline (Postgres)
                {sources.backend === 'env' && (
                  <span className="ml-2">
                    <SourceBadge source="env" />
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-xs text-paper-500">
                Store artifacts directly in the database. Simple setup, no extra infra.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              checked={backend === 's3'}
              className="mt-0.5 accent-ember-400"
              name="storage-backend"
              onChange={() => setBackend('s3')}
              type="radio"
              value="s3"
            />
            <span>
              <span className="text-sm text-paper-100">S3-compatible</span>
              <span className="mt-0.5 block text-xs text-paper-500">
                AWS S3, MinIO, Cloudflare R2, Backblaze B2, etc.
              </span>
            </span>
          </label>
        </div>
      </Card>

      {backend === 's3' && (
        <Card>
          <CardHeader>
            <CardTitle eyebrow="S3">Bucket configuration</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <ConfigField id="s3-bucket" label="Bucket" source={sources.s3Bucket}>
                <input
                  className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                  id="s3-bucket"
                  onChange={(e) => setS3Bucket(e.target.value)}
                  placeholder="my-auto-swe-bucket"
                  value={s3Bucket}
                />
              </ConfigField>
              <ConfigField id="s3-region" label="Region" source={sources.s3Region}>
                <input
                  className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                  id="s3-region"
                  onChange={(e) => setS3Region(e.target.value)}
                  placeholder="us-east-1"
                  value={s3Region}
                />
              </ConfigField>
            </div>
            <ConfigField
              id="s3-endpoint"
              label="Endpoint URL"
              note="(optional — leave blank for AWS)"
              source={sources.s3Endpoint}
            >
              <input
                className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                id="s3-endpoint"
                onChange={(e) => setS3Endpoint(e.target.value)}
                placeholder="https://s3.example.com"
                value={s3Endpoint}
              />
            </ConfigField>
            <ConfigField
              id="s3-prefix"
              label="Key prefix"
              note="(optional)"
              source={sources.s3Prefix}
            >
              <input
                className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                id="s3-prefix"
                onChange={(e) => setS3Prefix(e.target.value)}
                placeholder="auto-swe/"
                value={s3Prefix}
              />
            </ConfigField>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                checked={s3ForcePathStyle}
                className="accent-ember-400"
                id="s3-force-path-style"
                onChange={(e) => setS3ForcePathStyle(e.target.checked)}
                type="checkbox"
              />
              <span className="text-sm text-paper-300">Force path-style URLs</span>
              <span className="text-xs text-paper-500">
                (required for MinIO and some S3-compatible APIs)
              </span>
              <SourceBadge source={sources.s3ForcePathStyle} />
            </label>

            <div className="border-t border-ink-700 pt-4">
              <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
                Credentials
              </div>
              <div className="space-y-4">
                <ConfigField
                  current={data?.awsAccessKeyId || undefined}
                  id="aws-access-key-id"
                  label="Access key ID"
                  source={sources.awsAccessKeyId}
                >
                  <input
                    className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                    id="aws-access-key-id"
                    onChange={(e) => setAwsAccessKeyId(e.target.value)}
                    placeholder="AKIAIOSFODNN7EXAMPLE"
                    value={awsAccessKeyId}
                  />
                </ConfigField>
                <SecretInput
                  current={data?.awsSecretAccessKey ?? null}
                  id="aws-secret-access-key"
                  label="Secret access key"
                  onChange={setAwsSecretAccessKey}
                  source={sources.awsSecretAccessKey}
                  value={awsSecretAccessKey}
                />
              </div>
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <Button
              disabled={testing || !data?.s3Bucket}
              onClick={handleTest}
              size="sm"
              type="button"
              variant="secondary"
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
          </div>

          {testResult && (
            <p className={`mt-2 text-sm ${testResult.ok ? 'text-moss-400' : 'text-brick-400'}`}>
              {testResult.ok ? '✓' : '✗'} {testResult.detail}
            </p>
          )}
        </Card>
      )}

      {saved && <p className="text-sm text-moss-400">Settings saved.</p>}
      {error && <p className="text-sm text-brick-400">{error}</p>}

      <div className="flex justify-end">
        <Button disabled={update.isPending} type="submit" variant="primary">
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
