'use client';

// Detects unified diff (git or patch format)
function isUnifiedDiff(str: string): boolean {
  return str.trimStart().startsWith('diff --git') || str.includes('\n@@ ') || str.startsWith('@@ ');
}

function DiffLine({ line }: { line: string }) {
  // added line (not +++ header)
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return <div className="bg-moss-400/10 text-moss-300 px-1">{line || ' '}</div>;
  }
  // removed line (not --- header)
  if (line.startsWith('-') && !line.startsWith('---')) {
    return <div className="bg-brick-400/10 text-brick-300 px-1">{line || ' '}</div>;
  }
  // hunk header
  if (line.startsWith('@@ ')) {
    return <div className="bg-violet-400/5 text-violet-300 px-1">{line}</div>;
  }
  // file header lines
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  ) {
    return <div className="text-paper-600 px-1">{line}</div>;
  }
  return <div className="text-paper-300 px-1">{line || ' '}</div>;
}

export function DiffRenderer({ content }: { content: string }) {
  if (!content) {
    return null;
  }

  if (isUnifiedDiff(content)) {
    return (
      <div className="font-mono text-xs leading-5">
        {content.split('\n').map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
          <DiffLine key={i} line={line} />
        ))}
      </div>
    );
  }

  return (
    <pre className="text-xs font-mono text-paper-300 whitespace-pre-wrap break-words">
      {content}
    </pre>
  );
}
