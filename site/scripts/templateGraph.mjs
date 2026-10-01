/**
 * Draws a workflow spec as a mermaid flowchart, and summarises what it asks of people.
 *
 * The use-case pages are generated from the built-in templates rather than written by
 * hand, so a diagram can never show a step the template does not have. Edges come from
 * `nodeEdges` — the same function the schema's reference check and `validateSpec`'s
 * reachability analysis use — so this file decides how an edge is *labelled*, never
 * which edges exist.
 */

import { nodeEdges } from '../../packages/shared/src/workflow/spec.ts';

/** Node types that park a run until a person acts. */
export const HUMAN_NODE_TYPES = new Set([
  'humanApproval',
  'humanDecision',
  'humanInput',
  'humanReview',
]);

/** What each human node type asks for, in the words a reader would use. */
const HUMAN_KIND = {
  humanApproval: 'approval',
  humanDecision: 'decision',
  humanInput: 'input',
  humanReview: 'review',
};

/**
 * Signals are sent by something outside the run. Most are systems — CI, a deploy
 * pipeline — but the merge signal is a person merging the pull request on GitHub, and
 * a page that called that "waits for a signal" would hide the one decision the
 * platform never takes.
 */
const SIGNAL_LABEL = {
  ciPipelineSignal: 'CI result',
  deploymentGateSignal: 'Deployment gate decision',
  humanMergeSignal: 'A person merges the pull request',
  productionMonitorSignal: 'Production monitoring result',
  stagingDeploySignal: 'Staging deploy result',
};

/** Signals whose sender is a person rather than a system. */
export const HUMAN_SIGNALS = new Set(['humanMergeSignal']);

const TERMINATE_LABEL = {
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  SUCCESS: 'Done',
  TIMED_OUT: 'Timed out',
};

const EDGE_LABEL = {
  join: 'joined',
  onApprove: 'approved',
  onFalse: 'no',
  onReceive: 'received',
  onReject: 'rejected',
  onSubmit: 'submitted',
  onTimeout: 'timed out',
  onTrue: 'yes',
  subgraph: 'each branch',
};

const ACRONYMS = new Set(['api', 'ci', 'pr', 'prd', 'url']);

/** `draftResponse` → `Draft response`; `loadCiWaitConfig` → `Load CI wait config`. */
export function humanize(id) {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word, i) => {
      // Acronyms keep their case — including ones a camelCase id spells `Ci` or
      // `Pr` — and everything else is sentence case.
      if (ACRONYMS.has(word.toLowerCase())) {
        return word.toUpperCase();
      }
      if (word.length > 1 && word === word.toUpperCase()) {
        return word;
      }
      return i === 0 ? word[0].toUpperCase() + word.slice(1) : word.toLowerCase();
    });
  return words.join(' ');
}

/** Mermaid labels are quoted strings; a quote inside one ends it early. */
function quote(text) {
  return `"${String(text).replace(/"/g, '#quot;')}"`;
}

/**
 * Run bookkeeping: `set` nodes (status fields, retry counters) and `updateDomainState`
 * steps, which only write the run's status for the dashboard. Each has exactly one way
 * out. Drawing them doubles the size of the larger templates and tells a reader
 * nothing, so every edge into one is followed through to the node it leads to.
 */
function isBookkeeping(node) {
  return node?.type === 'set' || (node?.type === 'step' && node.step === 'updateDomainState');
}

function skipBookkeeping(nodes, id) {
  const seen = new Set();
  let current = id;
  while (isBookkeeping(nodes[current]) && nodes[current].next && !seen.has(current)) {
    seen.add(current);
    current = nodes[current].next;
  }
  return current;
}

function signalLabel(name) {
  return SIGNAL_LABEL[name] ?? humanize(name);
}

function nodeLabel(id, node) {
  switch (node.type) {
    case 'agent':
      return `${humanize(id)}<br/><small>agent: ${node.agentRef}</small>`;
    case 'cond':
      return `${humanize(id)}?`;
    case 'fanOut':
      return `${humanize(id)}<br/><small>runs branches in parallel</small>`;
    case 'shell':
    case 'containerStep':
      return `${humanize(id)}<br/><small>sandboxed container</small>`;
    case 'signal':
      return `${humanize(id)}<br/><small>waits up to ${node.timeout}: ${signalLabel(node.name)}</small>`;
    case 'terminate': {
      // Several ends often share a status — a rejection and a success both end
      // SUCCESS — so the node id, which says which ending this is, rides beneath.
      const status = TERMINATE_LABEL[node.status] ?? humanize(node.status.toLowerCase());
      const which = humanize(id.replace(/^terminate(?=[A-Z])/, '')).toLowerCase();
      return which === status.toLowerCase() ? status : `${status}<br/><small>${which}</small>`;
    }
    default:
      if (HUMAN_NODE_TYPES.has(node.type)) {
        return `${node.title}<br/><small>person: ${HUMAN_KIND[node.type]}</small>`;
      }
      return humanize(id);
  }
}

function nodeShape(mermaidId, label, node) {
  const text = quote(label);
  switch (node.type) {
    case 'cond':
      return `${mermaidId}{${text}}`;
    case 'terminate':
      return `${mermaidId}([${text}])`;
    case 'signal':
      return `${mermaidId}[/${text}/]`;
    case 'agent':
      return `${mermaidId}[[${text}]]`;
    default:
      return HUMAN_NODE_TYPES.has(node.type) ? `${mermaidId}>${text}]` : `${mermaidId}[${text}]`;
  }
}

function edgeLabel(node, field) {
  const option = /^options\[(\d+)\]\.next$/.exec(field);
  if (option && node.type === 'humanDecision') {
    return node.options[Number(option[1])]?.label;
  }
  return EDGE_LABEL[field];
}

/**
 * Renders the spec as a top-down mermaid flowchart.
 *
 * Only nodes reachable from `entry` are drawn, which is also what the interpreter can
 * ever run. Human nodes carry the `gate` class and signal waits the `wait` class, so
 * the site's stylesheet can mark the places a run stops in the gate colour.
 */
export function specToMermaid(spec) {
  const { nodes } = spec;
  const mermaidId = (id) => `n_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;

  const lines = ['flowchart TD'];
  const edges = [];
  const gates = [];
  const waits = [];
  const visited = new Set();
  const queue = [skipBookkeeping(nodes, spec.entry)];

  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id) || !nodes[id]) {
      continue;
    }
    visited.add(id);
    const node = nodes[id];

    lines.push(`  ${nodeShape(mermaidId(id), nodeLabel(id, node), node)}`);
    if (HUMAN_NODE_TYPES.has(node.type) || HUMAN_SIGNALS.has(node.name)) {
      gates.push(mermaidId(id));
    } else if (node.type === 'signal') {
      waits.push(mermaidId(id));
    }

    for (const [field, rawTarget] of nodeEdges(node)) {
      const target = skipBookkeeping(nodes, rawTarget);
      const label = edgeLabel(node, field);
      const arrow = label ? `-->|${quote(label)}|` : '-->';
      edges.push(`  ${mermaidId(id)} ${arrow} ${mermaidId(target)}`);
      queue.push(target);
    }
  }

  lines.push(...edges);
  if (gates.length > 0) {
    lines.push(`  class ${gates.join(',')} gate`);
  }
  if (waits.length > 0) {
    lines.push(`  class ${waits.join(',')} wait`);
  }
  return lines.join('\n');
}

/**
 * The facts a reader needs before reading the diagram: who has to act, what it waits
 * for, and which agents it runs. Derived, so it cannot claim a gate the spec lacks.
 */
export function summarizeSpec(spec) {
  const entries = Object.entries(spec.nodes);
  const people = entries.flatMap(([id, node]) => {
    if (HUMAN_NODE_TYPES.has(node.type)) {
      return [{ id, kind: HUMAN_KIND[node.type], timeout: node.timeout, title: node.title }];
    }
    if (node.type === 'signal' && HUMAN_SIGNALS.has(node.name)) {
      return [{ id, kind: 'merge', timeout: node.timeout, title: 'Merge the pull request' }];
    }
    return [];
  });
  const waits = entries
    .filter(([, node]) => node.type === 'signal' && !HUMAN_SIGNALS.has(node.name))
    .map(([, node]) => ({ name: signalLabel(node.name), timeout: node.timeout }));
  const agents = [
    ...new Set(entries.filter(([, node]) => node.type === 'agent').map(([, n]) => n.agentRef)),
  ];
  const parallel = entries.some(([, node]) => node.type === 'fanOut');
  const sandboxed = entries.some(
    ([, node]) => node.type === 'shell' || node.type === 'containerStep'
  );
  return { agents, parallel, people, sandboxed, waits };
}
