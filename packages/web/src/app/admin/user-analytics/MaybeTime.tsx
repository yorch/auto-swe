import { RelativeTime } from '@/components/ui/RelativeTime';

/** A time that may never have happened: "Never" rather than an invalid date. */
export function MaybeTime({ value }: { value: string | null }) {
  return value ? <RelativeTime value={value} /> : <span className="text-paper-500">Never</span>;
}
