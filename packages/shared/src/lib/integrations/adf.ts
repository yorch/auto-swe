/// Atlassian Document Format (ADF) utilities shared between Jira and Confluence providers.

/// ADF → plain text. Walks the node tree collecting `text` leaves;
/// paragraphs/blocks become newlines. Best-effort.
export function adfToPlainText(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  if (!node || typeof node !== 'object') {
    return '';
  }
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof n.text === 'string') {
    return n.text;
  }
  const children = Array.isArray(n.content) ? n.content.map(adfToPlainText) : [];
  const blockTypes = new Set([
    'paragraph',
    'heading',
    'blockquote',
    'codeBlock',
    'listItem',
    'bulletList',
    'orderedList',
    'rule',
  ]);
  const joined = children.join('');
  return n.type && blockTypes.has(n.type) ? `${joined}\n` : joined;
}

/// Build a minimal ADF document from plain text (for writes to Jira/Confluence).
export function adfFromText(text: string): unknown {
  return {
    content: [
      {
        content: [{ text, type: 'text' }],
        type: 'paragraph',
      },
    ],
    type: 'doc',
    version: 1,
  };
}
