import { Icon } from '@/components/ui/Icon';
import type { SocialProviderId } from '@/stores/authStore';

/**
 * A recognisable, single-colour mark per sign-in provider, drawn inline so
 * there is no asset to load. Brand marks are bespoke artwork rather than UI
 * glyphs, which is why they are not in the `Icon` set; Slack, which has no mark
 * here, falls back to the chat glyph.
 */
export function ProviderMark({ id, size = 16 }: { id: SocialProviderId | 'slack'; size?: number }) {
  if (id === 'github') {
    return (
      <svg aria-hidden="true" fill="currentColor" height={size} viewBox="0 0 16 16" width={size}>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
    );
  }
  if (id === 'google') {
    return (
      <svg aria-hidden="true" fill="currentColor" height={size} viewBox="0 0 24 24" width={size}>
        <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.85 3.19-1.79 4.13-1.15 1.15-2.93 2.4-6.05 2.4-4.83 0-8.6-3.89-8.6-8.72s3.77-8.72 8.6-8.72c2.6 0 4.51 1.03 5.91 2.35l2.31-2.31C18.75 1.44 16.13 0 12.48 0 5.87 0 .31 5.39.31 12s5.56 12 12.17 12c3.57 0 6.27-1.17 8.37-3.36 2.16-2.16 2.84-5.21 2.84-7.67 0-.76-.05-1.47-.17-2.05H12.48z" />
      </svg>
    );
  }
  if (id === 'okta') {
    return (
      <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 16 16" width={size}>
        <circle cx={8} cy={8} r={5} stroke="currentColor" strokeWidth={3} />
      </svg>
    );
  }
  return <Icon name="chat" size={size} />;
}
