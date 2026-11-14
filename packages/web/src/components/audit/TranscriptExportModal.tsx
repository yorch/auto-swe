'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Checkbox } from '@/components/ui/Checkbox';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { exportTranscripts } from '@/hooks/useTranscripts';
import { type DateRange, dayBounds } from '@/lib/dateRange';
import { errMsg } from '@/lib/errors';

/** The most days one export may span; the gateway refuses a longer range. */
const MAX_EXPORT_DAYS = 31;

const FORMAT_OPTIONS = [
  { label: 'Raw records', value: 'raw' },
  { label: 'Normalized records', value: 'normalized' },
];

/**
 * Downloads the agent transcripts of a date range, across all tenants, as one NDJSON file. The
 * export is recorded in the transcript access log like any other read.
 */
export function TranscriptExportModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const [range, setRange] = useState<DateRange>({ days: 7, kind: 'preset' });
  const [format, setFormat] = useState<'raw' | 'normalized'>('raw');
  const [scrubPii, setScrubPii] = useState(false);
  const [agentKey, setAgentKey] = useState('');
  const [activityType, setActivityType] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const { since, until } = dayBounds(range);
      await exportTranscripts({
        activityType,
        agentKey,
        format,
        from: since,
        scrubPii,
        to: until,
      });
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Could not export the transcripts'));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      dismissible={!pending}
      onClose={onClose}
      open={open}
      subtitle="One NDJSON file of every transcript created in the range, across all tenants."
      title="Export transcripts"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-1">
          <span className="text-sm font-medium text-paper-200">Created in</span>
          <DateRangeControl
            maxSpanDays={MAX_EXPORT_DAYS}
            onChange={(r) => r && setRange(r)}
            presets={[7, 14, MAX_EXPORT_DAYS]}
            value={range}
          />
          <p className="text-xs text-paper-500">At most {MAX_EXPORT_DAYS} days per export.</p>
        </div>
        <Select
          label="Format"
          onChange={(v) => setFormat(v === 'normalized' ? 'normalized' : 'raw')}
          options={FORMAT_OPTIONS}
          value={format}
        />
        <Input
          hint="Only transcripts that include this agent. Blank exports all."
          label="Agent key"
          onChange={(e) => setAgentKey(e.target.value)}
          placeholder="implementer"
          value={agentKey}
        />
        <Input
          hint="Only transcripts of this activity type. Blank exports all."
          label="Activity type"
          onChange={(e) => setActivityType(e.target.value)}
          placeholder="executeImplementation"
          value={activityType}
        />
        <Checkbox
          checked={scrubPii}
          hint="Masks personal data in the exported records."
          label="Scrub personal data"
          onChange={(e) => setScrubPii(e.target.checked)}
        />
        {error && <Alert variant="error">{error}</Alert>}
        <ModalFooter
          isPending={pending}
          onCancel={onClose}
          pendingLabel="Exporting…"
          submitLabel="Export"
        />
      </form>
    </Modal>
  );
}
