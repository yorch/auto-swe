'use client';

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { DocLink } from '@/components/ui/DocLink';
import { Icon } from '@/components/ui/Icon';
import { nodeHelp } from '@/lib/nodeHelp';
import { cn, FOCUS_RING } from '@/lib/utils';
import { isKnownNodeType, NODE_TYPE_LABEL } from './nodeTypeTone';

/**
 * Collapsed-by-default explanation of the selected node's type: what it does, when to use it, the
 * field that trips people up, and a small example. The summary is plain text (nothing interactive
 * inside it); the docs link lives in the body.
 */
export function NodeHelpPanel({ type }: { type: SpecNode['type'] }) {
  // A type this build does not know has no help entry; render nothing rather than read through undefined.
  if (!isKnownNodeType(type)) {
    return null;
  }
  const help = nodeHelp(type);
  const label = NODE_TYPE_LABEL[type];
  return (
    <details className="group px-4 pt-3" key={type}>
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-[13px] font-semibold text-paper-100 [&::-webkit-details-marker]:hidden',
          FOCUS_RING
        )}
      >
        <Icon
          className="text-paper-500 transition-transform group-open:rotate-90"
          name="chevronRight"
          size={13}
        />
        About {label} nodes
      </summary>
      <div className="mt-2 space-y-2 text-[13px] leading-relaxed text-paper-300">
        <p>{help.what}</p>
        <p>
          <span className="font-semibold text-paper-100">Use it when: </span>
          {help.when}
        </p>
        <p>
          <span className="font-semibold text-paper-100">Watch out: </span>
          {help.gotcha}
        </p>
        <p>
          <span className="font-semibold text-paper-100">Output: </span>
          {help.output}
        </p>
        <div>
          <div className="mb-1 font-semibold text-paper-100">Example</div>
          <pre className="max-h-48 overflow-auto rounded-md border border-ink-600 bg-ink-900 p-2.5 font-mono text-[11px] leading-relaxed text-paper-300">
            {JSON.stringify(help.example, null, 2)}
          </pre>
        </div>
        <DocLink
          anchor={help.doc.anchor}
          label={`Read more about ${label.toLowerCase()} nodes`}
          slug={help.doc.slug}
        />
      </div>
    </details>
  );
}
