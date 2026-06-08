import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        'max-w-none text-sm leading-relaxed text-paper-100',
        '[&_h1]:text-3xl [&_h1]:font-bold [&_h1]:mt-0 [&_h1]:mb-6',
        '[&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:mt-8 [&_h2]:mb-4 [&_h2]:border-b [&_h2]:border-ink-600 [&_h2]:pb-2',
        '[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-6 [&_h3]:mb-3',
        '[&_h4]:text-base [&_h4]:font-semibold [&_h4]:mt-4 [&_h4]:mb-2',
        '[&_p]:my-3',
        '[&_a]:text-ember-400 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:no-underline',
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1',
        '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:space-y-1',
        '[&_li]:leading-relaxed',
        '[&_blockquote]:border-l-4 [&_blockquote]:border-ink-600 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-paper-400 [&_blockquote]:my-4',
        '[&_code]:font-mono [&_code]:text-[0.85em] [&_code]:bg-ink-700 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded',
        '[&_pre]:bg-[#0f172a] [&_pre]:text-[#e2e8f0] [&_pre]:p-4 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_pre]:my-4 [&_pre]:text-xs',
        '[&_pre_code]:bg-transparent [&_pre_code]:text-inherit [&_pre_code]:p-0',
        '[&_table]:w-full [&_table]:my-4 [&_table]:border-collapse [&_table]:text-xs',
        '[&_th]:border [&_th]:border-ink-600 [&_th]:bg-ink-700 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold',
        '[&_td]:border [&_td]:border-ink-600 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
        '[&_hr]:my-6 [&_hr]:border-ink-600',
        '[&_img]:max-w-full [&_img]:rounded-md [&_img]:my-4',
        '[&_strong]:font-semibold',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
