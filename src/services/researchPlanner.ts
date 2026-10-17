// ================================================================
// Research Planner — deterministic research plan per knowledge type
// ================================================================

export interface ResearchPlan {
  objectives: string[];
  dimensions: string[];
  searchQueries: string[];
  sourcePriorities: string[];
  verificationRequired: boolean;
  mediaResearch: boolean;
  priceResearch: boolean;
  completionCriteria: string[];
}

const DEFAULT_DIMENSIONS = [
  'definition',
  'history',
  'attributes',
  'relationships',
  'use_cases',
  'limitations',
  'sources',
];

const DEVICE_DIMENSIONS = [
  'soc',
  'cpu',
  'gpu',
  'npu',
  'ram',
  'storage',
  'display',
  'camera',
  'battery',
  'charging',
  'connectivity',
  'os',
  'firmware',
  'benchmarks',
  'thermal',
  'battery_life',
  'real_world',
];

const SOFTWARE_DIMENSIONS = [
  'features',
  'architecture',
  'docs',
  'compatibility',
  'version_history',
  'known_issues',
  'performance',
];

const CODE_BUG_DIMENSIONS = [
  'language',
  'version',
  'environment',
  'error_message',
  'repro_steps',
  'root_cause',
  'fix',
  'workarounds',
  'version_differences',
];

const MATH_DIMENSIONS = [
  'definition',
  'variables',
  'units',
  'conditions',
  'derivation',
  'equivalent_forms',
  'boundary_conditions',
  'examples',
  'common_errors',
];

const ORGANISM_DIMENSIONS = [
  'taxonomy',
  'morphology',
  'habitat',
  'distribution',
  'behavior',
  'ecology',
  'reproduction',
  'conservation',
];

const CONCEPT_DIMENSIONS = [
  'definition',
  'history',
  'variants',
  'implementations',
  'use_cases',
  'limitations',
];

const SOURCE_PRIORITY_ORDER = [
  'official',
  'professional_technical',
  'benchmark_lab',
  'academic',
  'community',
  'social',
  'video',
];

function isDeviceType(rawType: string): boolean {
  return rawType.includes('device') || rawType.includes('hardware');
}

function dimensionsForType(rawType: string): string[] {
  if (isDeviceType(rawType)) return DEVICE_DIMENSIONS;
  if (
    rawType.includes('software') ||
    rawType.includes('api') ||
    rawType.includes('sdk') ||
    rawType === 'tool'
  ) {
    return SOFTWARE_DIMENSIONS;
  }
  if (rawType.includes('code') || rawType.includes('bug')) return CODE_BUG_DIMENSIONS;
  if (rawType.includes('math') || rawType.includes('formula')) return MATH_DIMENSIONS;
  if (rawType.includes('organism') || rawType.includes('plant') || rawType.includes('animal')) {
    return ORGANISM_DIMENSIONS;
  }
  if (rawType.includes('concept') || rawType.includes('standard') || rawType.includes('protocol')) {
    return CONCEPT_DIMENSIONS;
  }
  return DEFAULT_DIMENSIONS;
}

function factDimension(f: any): string {
  if (!f) return '';
  return String(f.dimension ?? f.dimensionKey ?? f.claimType ?? '').toLowerCase();
}

export async function planResearch(
  object: any,
  blindSpot: any,
  existingFacts: any[],
  opts?: { region?: string; verification?: string },
): Promise<ResearchPlan> {
  const rawType = String(object?.objectType ?? '');
  const title = String(object?.title ?? 'unknown subject');
  const dims = dimensionsForType(rawType);

  const covered = new Set<string>();
  for (const f of Array.isArray(existingFacts) ? existingFacts : []) {
    const d = factDimension(f);
    if (d) covered.add(d);
  }
  const uncovered = dims.filter((d) => !covered.has(d.toLowerCase()));

  const region = opts?.region;
  const device = isDeviceType(rawType);
  const organism = rawType.includes('organism') || rawType.includes('plant') || rawType.includes('animal');

  const objectives: string[] = [];
  if (blindSpot?.gapDescription) {
    objectives.push(`Resolve gap: ${blindSpot.gapDescription}`);
  }
  objectives.push(`Establish verified facts for ${title} across dimensions: ${dims.join(', ')}`);
  if (uncovered.length > 0) {
    objectives.push(`Prioritize uncovered dimensions: ${uncovered.join(', ')}`);
  }
  if (region) {
    objectives.push(`Prioritize region-specific data for ${region} (availability, pricing, regulation)`);
  }

  const querySubjects: string[] = [];
  const queryTerms = uncovered.length > 0 ? uncovered : dims;
  for (const dim of queryTerms) {
    const dimLabel = dim.replace(/_/g, ' ');
    if (region && (dim.includes('price') || dim.includes('availability'))) {
      querySubjects.push(`${title} ${dimLabel} ${region}`);
    } else {
      querySubjects.push(`${title} ${dimLabel}`);
    }
  }
  const searchQueries: string[] = Array.from(
    new Set([
      ...querySubjects,
      device ? `${title} geekwan 极客湾 review` : '',
      region ? `${title} ${region}` : '',
    ]),
  ).filter((q) => q.length > 0);

  const sourcePriorities: string[] = [...SOURCE_PRIORITY_ORDER];
  if (device) sourcePriorities.unshift('benchmark_lab', 'geekwan');

  const verificationRequired = opts?.verification !== 'none';

  const completionCriteria: string[] = [
    `All uncovered dimensions (${uncovered.length}) have at least one sourced fact`,
    'Facts cite traceable source URLs',
  ];
  if (verificationRequired) {
    completionCriteria.push('Numeric/technical claims cross-checked against at least two independent sources');
  }
  if (region) {
    completionCriteria.push(`Region ${region} specificity confirmed or explicitly marked N/A`);
  }

  return {
    objectives,
    dimensions: dims,
    searchQueries,
    sourcePriorities,
    verificationRequired,
    mediaResearch: organism || device,
    priceResearch: device,
    completionCriteria,
  };
}

export { isDeviceType };
