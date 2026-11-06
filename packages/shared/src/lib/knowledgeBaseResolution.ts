export type KnowledgeBaseSource = 'TEAM' | 'REPO' | 'TEMPLATE' | 'RUN';

export const MAX_DEPENDENCY_CHECKOUTS = 4;

export interface KnowledgeBaseResolutionLink {
  knowledgeBaseId: string;
  ref?: string | null;
  mountName?: string | null;
  mandatory?: boolean;
  exclude?: boolean;
}

export interface KnowledgeBaseOverrides {
  add?: Array<{ knowledgeBaseId: string; ref?: string | null }>;
  exclude?: string[];
}

export interface ResolvedKnowledgeBase {
  knowledgeBaseId: string;
  ref: string | null;
  mountName: string | null;
  mandatory: boolean;
  source: KnowledgeBaseSource;
}

const specificity: Record<KnowledgeBaseSource, number> = { REPO: 1, RUN: 3, TEAM: 0, TEMPLATE: 2 };

export function resolveKnowledgeBaseSet(input: {
  teamLinks?: readonly KnowledgeBaseResolutionLink[];
  repoLinks?: readonly KnowledgeBaseResolutionLink[];
  templateLinks?: readonly KnowledgeBaseResolutionLink[];
  runOverrides?: KnowledgeBaseOverrides | null;
  cap: number;
}): {
  selected: ResolvedKnowledgeBase[];
  dropped: ResolvedKnowledgeBase[];
  refusedExclusions: string[];
} {
  if (!Number.isSafeInteger(input.cap) || input.cap < 0) {
    throw new RangeError('Knowledge base cap must be a non-negative safe integer');
  }
  const mandatory = new Set(
    (input.teamLinks ?? []).filter((link) => link.mandatory).map((link) => link.knowledgeBaseId)
  );
  const candidates = new Map<string, ResolvedKnowledgeBase>();
  const refused = new Set<string>();
  const exclude = (id: string) => {
    if (mandatory.has(id)) {
      refused.add(id);
    } else {
      candidates.delete(id);
    }
  };
  const add = (links: readonly KnowledgeBaseResolutionLink[], source: KnowledgeBaseSource) => {
    for (const link of links) {
      if (link.exclude) {
        continue;
      }
      candidates.set(link.knowledgeBaseId, {
        knowledgeBaseId: link.knowledgeBaseId,
        mandatory: mandatory.has(link.knowledgeBaseId),
        mountName: link.mountName ?? null,
        ref: link.ref ?? null,
        source,
      });
    }
  };
  add(input.teamLinks ?? [], 'TEAM');
  add(input.repoLinks ?? [], 'REPO');
  for (const link of input.templateLinks ?? []) {
    if (link.exclude) {
      exclude(link.knowledgeBaseId);
    }
  }
  add(input.templateLinks ?? [], 'TEMPLATE');
  add(input.runOverrides?.add ?? [], 'RUN');
  for (const id of input.runOverrides?.exclude ?? []) {
    exclude(id);
  }
  const sorted = [...candidates.values()].sort(
    (a, b) =>
      Number(b.mandatory) - Number(a.mandatory) ||
      specificity[b.source] - specificity[a.source] ||
      a.knowledgeBaseId.localeCompare(b.knowledgeBaseId)
  );
  return {
    dropped: sorted.slice(input.cap),
    refusedExclusions: [...refused].sort(),
    selected: sorted.slice(0, input.cap),
  };
}
