'use client';

import { useState } from 'react';
import { GitHubTab } from '@/components/integrations/GitHubTab';
import { OAuthTab } from '@/components/integrations/OAuthTab';
import { SlackTab } from '@/components/integrations/SlackTab';
import { StorageTab } from '@/components/integrations/StorageTab';

type Tab = 'github' | 'slack' | 'storage' | 'oauth';

const TABS: { id: Tab; label: string }[] = [
  { id: 'github', label: 'GitHub' },
  { id: 'slack', label: 'Slack' },
  { id: 'storage', label: 'Storage' },
  { id: 'oauth', label: 'OAuth' },
];

export default function AdminIntegrationsPage() {
  const [active, setActive] = useState<Tab>('github');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Admin — Integrations</h2>
        <p className="mt-1 text-sm text-paper-400">
          Configure GitHub, Slack, storage backend, and OAuth provider credentials. Masked fields
          show only the last four characters — enter a new value to rotate.
        </p>
      </div>
      <div className="border-b border-ink-600">
        <nav className="flex gap-1">
          {TABS.map((tab) => (
            <button
              className={`border-b-2 px-4 py-2 text-sm transition-colors ${
                active === tab.id
                  ? 'border-ember-400 text-ember-400'
                  : 'border-transparent text-paper-400 hover:text-paper-100'
              }`}
              key={tab.id}
              onClick={() => setActive(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>
      {active === 'github' && <GitHubTab />}
      {active === 'slack' && <SlackTab />}
      {active === 'storage' && <StorageTab />}
      {active === 'oauth' && <OAuthTab />}
    </div>
  );
}
