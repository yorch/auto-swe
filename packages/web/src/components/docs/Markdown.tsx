import Link from 'next/link';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isSafeExternalUrl, resolveDocLink } from '@/lib/docLinks';
import { headingIdFactory, headingText } from '@/lib/docToc';
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

/** Plain text of rendered heading children, for the id the contents list links to. */
function nodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(nodeText).join('');
  }
  if (node && typeof node === 'object' && 'props' in node) {
    return nodeText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return '';
}

/** h2/h3 with anchor ids matching `extractToc`, in render order. */
function headingComponents(): Pick<Components, 'h2' | 'h3'> {
  const nextId = headingIdFactory();
  return {
    h2: ({ children, node: _node, ...rest }) => (
      <h2 id={nextId(headingText(nodeText(children)))} {...rest}>
        {children}
      </h2>
    ),
    h3: ({ children, node: _node, ...rest }) => (
      <h3 id={nextId(headingText(nodeText(children)))} {...rest}>
        {children}
      </h3>
    ),
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
        <span className="mb-3 flex items-center gap-1.5 border-b border-ink-600 pb-2 font-sans text-xs text-paper-500">
          Mermaid diagram source — renders as a diagram in the repository
        </span>
      ) : null}
      {children}
    </code>
  );
};

/** Tables scroll inside their own framed wrapper, so a wide one never widens the page. */
const docTable: Components['table'] = ({ children, node: _node, ...rest }) => (
  <div className="my-6 overflow-x-auto rounded-lg border border-ink-500/70">
    <table {...rest}>{children}</table>
  </div>
);

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
        'max-w-none text-[15px] leading-7 text-paper-300',
        // Headings
        '[&_h1]:mt-0 [&_h1]:mb-6 [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:leading-tight [&_h1]:tracking-[-0.02em] [&_h1]:text-paper-50 md:[&_h1]:text-[34px]',
        '[&_h2]:scroll-mt-20 [&_h2]:mt-12 [&_h2]:mb-4 [&_h2]:border-b [&_h2]:border-ink-600 [&_h2]:pb-2.5 [&_h2]:text-[22px] [&_h2]:font-semibold [&_h2]:leading-snug [&_h2]:tracking-tight [&_h2]:text-paper-50',
        '[&_h3]:scroll-mt-20 [&_h3]:mt-9 [&_h3]:mb-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:text-paper-100',
        '[&_h4]:mt-7 [&_h4]:mb-2 [&_h4]:text-base [&_h4]:font-semibold [&_h4]:text-paper-100',
        '[&_h2+*]:mt-0 [&_h3+*]:mt-0',
        // Body
        '[&_p]:my-4',
        '[&_strong]:font-semibold [&_strong]:text-paper-100',
        '[&_a]:font-medium [&_a]:text-ember-300 [&_a]:underline [&_a]:decoration-ember-400/40 [&_a]:underline-offset-[3px] [&_a]:transition-colors hover:[&_a]:text-ember-200 hover:[&_a]:decoration-ember-300',
        // Lists
        '[&_ul]:my-4 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6',
        '[&_ol]:my-4 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-6',
        '[&_li]:pl-1 [&_li]:marker:text-paper-600 [&_li>ul]:my-1.5 [&_li>ol]:my-1.5',
        // Quotes and rules
        '[&_blockquote]:my-6 [&_blockquote]:rounded-r-lg [&_blockquote]:border-l-[3px] [&_blockquote]:border-ember-400/60 [&_blockquote]:bg-ink-700/50 [&_blockquote]:px-4 [&_blockquote]:py-1 [&_blockquote]:text-paper-400',
        '[&_hr]:my-10 [&_hr]:border-ink-600',
        // Code
        '[&_code]:rounded-md [&_code]:border [&_code]:border-ink-500/70 [&_code]:bg-ink-700 [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-paper-100',
        '[&_pre]:my-6 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-ink-500/70 [&_pre]:bg-ink-950 [&_pre]:p-4 [&_pre]:text-[13px] [&_pre]:leading-6 [&_pre]:text-paper-200',
        '[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit',
        // Tables — the wrapper (see `docTable`) scrolls a wide one sideways
        '[&_table]:w-full [&_table]:border-collapse [&_table]:text-[13.5px] [&_table]:leading-6',
        '[&_thead]:bg-ink-700/70',
        '[&_th]:border-b [&_th]:border-ink-500 [&_th]:px-3.5 [&_th]:py-2.5 [&_th]:text-left [&_th]:font-semibold [&_th]:whitespace-nowrap [&_th]:text-paper-100',
        '[&_td]:border-t [&_td]:border-ink-600 [&_td]:px-3.5 [&_td]:py-2.5 [&_td]:align-top [&_td_code]:whitespace-nowrap',
        '[&_tbody_tr:hover]:bg-ink-700/40',
        // Media
        '[&_img]:my-6 [&_img]:max-w-full [&_img]:rounded-lg [&_img]:border [&_img]:border-ink-500/60',
        className
      )}
    >
      <ReactMarkdown
        components={
          servedSlugs
            ? {
                a: docAnchor(servedSlugs),
                code: docCode,
                table: docTable,
                ...headingComponents(),
              }
            : { table: docTable }
        }
        remarkPlugins={[remarkGfm]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
