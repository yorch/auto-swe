/**
 * Server-sent events: parse an SSE body into `data:` payloads (JSON-parsed
 * where possible). Provider streams differ only in their event JSON.
 */
export function parseSseEvents(body: string): unknown[] {
  const events: unknown[] = [];
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') {
      return;
    }
    try {
      events.push(JSON.parse(data));
    } catch {
      // A non-JSON data line carries nothing the normalizer reads.
    }
  };
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      flush();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return events;
}
