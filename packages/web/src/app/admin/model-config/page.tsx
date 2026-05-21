'use client';

import { useState } from 'react';
import { AuditLogTab } from '@/components/modelConfig/AuditLogTab';
import { CredentialsTab } from '@/components/modelConfig/CredentialsTab';
import { MidRunWarning } from '@/components/modelConfig/MidRunWarning';
import { RolesTab } from '@/components/modelConfig/RolesTab';

type Tab = 'roles' | 'credentials' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'roles', label: 'Roles' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'audit', label: 'Audit log' },
];

export default function AdminModelConfigPage() {
  const [active, setActive] = useState<Tab>('roles');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Admin — Model configuration</h2>
        <p className="mt-1 text-sm text-paper-400">
          Per-role model picks, encrypted provider credentials, and the audit trail. Edits here
          apply system-wide. For per-team overrides, edit the team's settings page.
        </p>
      </div>
      <MidRunWarning />
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
      {active === 'roles' && <RolesTab />}
      {active === 'credentials' && <CredentialsTab />}
      {active === 'audit' && <AuditLogTab />}
    </div>
  );
}
