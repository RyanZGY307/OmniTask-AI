// ================================================================
// Source Router — route research plans to appropriate sources
// ================================================================

import type { ResearchPlan } from './researchPlanner';

export interface SourceRoute {
  sourceType: string;
  priority: number;
  domains: string[];
  queries: string[];
  isOfficial: boolean;
}

const PRIORITY_BY_TYPE: Record<string, number> = {
  official: 1,
  professional_technical: 2,
  benchmark_lab: 3,
  geekwan: 3,
  academic: 4,
  community: 5,
  social: 6,
  video: 7,
};

const DEFAULT_DOMAINS: Record<string, string[]> = {
  official: [],
  professional_technical: ['reddit.com'],
  benchmark_lab: ['socpk.com'],
  geekwan: ['geekwan.com', 'bilibili.com'],
  academic: ['arxiv.org', 'wikipedia.org'],
  community: ['stackoverflow.com'],
  social: ['twitter.com'],
  video: ['youtube.com', 'bilibili.com'],
};

interface CategoryExtra {
  sourceType: string;
  domains: string[];
  queries: string[];
  isOfficial: boolean;
}

const CATEGORY_EXTRAS: Record<string, CategoryExtra[]> = {
  device: [
    { sourceType: 'benchmark_lab', domains: ['socpk.com'], queries: ['{title} SoC teardown benchmark'], isOfficial: false },
    { sourceType: 'geekwan', domains: ['geekwan.com', 'bilibili.com'], queries: ['{title} 极客湾 拆解 实测'], isOfficial: false },
    { sourceType: 'professional_technical', domains: ['anandtech.com', 'notebookcheck.net', 'gsmarena.com'], queries: ['{title} review specifications'], isOfficial: false },
    { sourceType: 'official', domains: [], queries: ['{title} official specs'], isOfficial: true },
  ],
  code: [
    { sourceType: 'official', domains: ['github.com'], queries: ['{title} issue github'], isOfficial: true },
    { sourceType: 'community', domains: ['stackoverflow.com'], queries: ['{title} error stack overflow'], isOfficial: false },
    { sourceType: 'official', domains: ['nodejs.org', 'developer.mozilla.org', 'docs.python.org'], queries: ['{title} official docs'], isOfficial: true },
  ],
  math: [
    { sourceType: 'academic', domains: ['arxiv.org', 'washington.edu'], queries: ['{title} derivation proof'], isOfficial: false },
    { sourceType: 'professional_technical', domains: ['wolframalpha.com', 'wikipedia.org'], queries: ['{title} formula'], isOfficial: false },
  ],
  organism: [
    { sourceType: 'community', domains: ['inaturalist.org'], queries: ['{title} species photo'], isOfficial: false },
    { sourceType: 'academic', domains: ['iucnredlist.org', 'gbif.org', 'flora.org'], queries: ['{title} distribution conservation status'], isOfficial: false },
  ],
  concept: [
    { sourceType: 'academic', domains: ['wikipedia.org'], queries: ['{title} definition history'], isOfficial: false },
    { sourceType: 'professional_technical', domains: ['ietf.org', 'nintendo.com'], queries: ['{title} specification protocol'], isOfficial: false },
  ],
  software: [
    { sourceType: 'official', domains: [], queries: ['{title} official docs'], isOfficial: true },
    { sourceType: 'community', domains: ['github.com', 'stackoverflow.com'], queries: ['{title} issue compatibility'], isOfficial: false },
  ],
};

function detectCategory(object: any): string {
  const t = String(object?.objectType ?? '').toLowerCase();
  const product = String(object?.product ?? '').toLowerCase();
  const title = String(object?.title ?? '').toLowerCase();
  const hay = `${t} ${product} ${title}`;
  if (hay.includes('device') || hay.includes('hardware')) return 'device';
  if (hay.includes('code') || hay.includes('bug')) return 'code';
  if (hay.includes('math') || hay.includes('formula')) return 'math';
  if (hay.includes('organism') || hay.includes('plant') || hay.includes('animal')) return 'organism';
  if (hay.includes('concept') || hay.includes('standard') || hay.includes('protocol')) return 'concept';
  if (hay.includes('software') || hay.includes('api') || hay.includes('sdk')) return 'software';
  return 'default';
}

function fillTemplate(tpl: string, title: string): string {
  return tpl.replace(/\{title\}/g, title);
}

export function routeSources(plan: ResearchPlan, object: any): SourceRoute[] {
  const title = String(object?.title ?? '');
  const category = detectCategory(object);
  const extras = CATEGORY_EXTRAS[category] ?? [];

  const byType = new Map<string, SourceRoute>();

  const typeSet = new Set<string>();
  for (const st of plan.sourcePriorities ?? []) typeSet.add(st);
  for (const ex of extras) typeSet.add(ex.sourceType);

  for (const st of typeSet) {
    const route: SourceRoute = {
      sourceType: st,
      priority: PRIORITY_BY_TYPE[st] ?? 7,
      domains: [...(DEFAULT_DOMAINS[st] ?? [])],
      queries: title
        ? (plan.searchQueries ?? []).slice(0, 5)
        : [],
      isOfficial: st === 'official',
    };
    byType.set(st, route);
  }

  for (const ex of extras) {
    const route = byType.get(ex.sourceType) ?? {
      sourceType: ex.sourceType,
      priority: PRIORITY_BY_TYPE[ex.sourceType] ?? 7,
      domains: [],
      queries: [],
      isOfficial: ex.isOfficial,
    };
    for (const d of ex.domains) {
      if (!route.domains.includes(d)) route.domains.push(d);
    }
    for (const q of ex.queries) {
      const filled = fillTemplate(q, title);
      if (filled && !route.queries.includes(filled)) route.queries.push(filled);
    }
    if (ex.isOfficial) route.isOfficial = true;
    byType.set(ex.sourceType, route);
  }

  const routes = Array.from(byType.values());
  routes.sort((a, b) => a.priority - b.priority || a.sourceType.localeCompare(b.sourceType));
  return routes;
}
