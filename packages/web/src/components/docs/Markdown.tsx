import Link from 'next/link';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isSafeExternalUrl, resolveDocLink } from '@/lib/docLinks';
import { cn } from '@/lib/utils';

/**
 * Anchor renderer for the docs surface.
 *
 * Docs are authored to be read as files, so their cross-references are
 * filesystem-relative. Left raw, every one of them 404s as a URL — see
 * `lib/docLinks.ts`. A link we cannot serve degrades to plain text with a
 * tooltip, because a link that goes nowhere is worse than prose.
 */
function docAnchor(servedSlugs: ReadonlySet<string>): Components['a'] {
  // `node` is react-markdown's mdast node. It is not a DOM attribute, and
  // spreading it onto the element stamps node="[object Object]" into the HTML.
  return ({ children, href, node: _node, ...rest }) => {
    const resolved = resolveDocLink(href ?? '', servedSlugs);

    if (resolved.kind === 'unserved') {
      return (
        <span
          className="text-paper-400 underline decoration-dotted underline-offset-2"
          title={`${href} — ${resolved.reason}. It lives in the repository.`}
        >
          {children}
        </span>
      );
    }

    if (isSafeExternalUrl(resolved.href)) {
      return (
        <a href={resolved.href} rel="noopener noreferrer" target="_blank" {...rest}>
          {children}
        </a>
      );
    }
    // Doc-to-doc links stay inside the app, so they route client-side rather
    // than reloading the shell for every cross-reference.
    return (
      <Link href={resolved.href} {...rest}>
        {children}
      </Link>
    );
  };
}

/**
 * Fenced-code renderer.
 *
 * The docs carry mermaid diagrams, and nothing here renders them — the library
 * costs 79 packages and ~123 MiB installed to draw eight diagrams in two docs,
 * which is a dependency decision on its own, not a side effect of fixing links.
 * Until that call is made, say plainly that the block is diagram source instead
 * of dropping a reader into unexplained syntax.
 */
const docCode: Components['code'] = ({ children, className, node: _node, ...rest }) => {
  const language = /language-([\w-]+)/.exec(className ?? '')?.[1];
  return (
    <code className={className} {...rest}>
      {language === 'mermaid' ? (
        <span className="block mb-2 pb-2 border-b border-white/10 text-[0.9em] not-italic text-paper-400">
          Mermaid diagram source — renders as a diagram in the repository
        </span>
      ) : null}
      {children}
    </code>
  );
};

export function Markdown({
  children,
  className,
  servedSlugs,
}: {
  children: string;
  className?: string;
  /**
   * Doc slugs `/docs/[slug]` will render. Supplied only by the docs surface —
   * without it, relative links are left exactly as authored.
   */
  servedSlugs?: ReadonlySet<string>;
}) {
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
      <ReactMarkdown
        components={servedSlugs ? { a: docAnchor(servedSlugs), code: docCode } : undefined}
        remarkPlugins={[remarkGfm]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
