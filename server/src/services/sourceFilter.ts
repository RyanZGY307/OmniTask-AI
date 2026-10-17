// ================================================================
// Source Filter — deterministic source filtering (no LLM)
// ================================================================

export interface RawSourceResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  publishedDate?: string;
}

export interface FilteredSource {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  isOfficial: boolean;
  relevance: number;
}

export interface FilterOptions {
  query?: string;
  region?: string;
  maxPerDomain?: number;
}

const TRACKING_PARAM_RE = /^(utm_|gcl(id)?|fbclid|ref|s[ps]c|igshid)$/i;

const KNOWN_OFFICIAL_DOMAINS = new Set([
  'apple.com', 'samsung.com', 'xiaomi.com', 'huawei.com', 'honor.com',
  'oppo.com', 'vivo.com', 'oneplus.com', 'google.com', 'intel.com',
  'amd.com', 'nvidia.com', 'qualcomm.com', 'mediatek.com', 'apple.com.cn',
  'developer.apple.com', 'samsungsemiconductor.com', 'tsmc.com', 'skhynix.com',
  'micron.com', 'nintendo.com', 'sony.com', 'microsoft.com',
]);

// Known region-specific domains (used for optional region filtering)
const REGION_DOMAINS: Record<string, string[]> = {
  CN: ['bilibili.com', 'zhihu.com', 'weibo.com', 'smzdm.com', 'ithome.com', 'geekwan.com', 'huya.com', 'douyin.com'],
  JP: ['youtube.co.jp', 'note.com', 'yahoo.co.jp'],
  KR: ['youtube.co.kr'],
  EU: ['gsmarena.com', 'notebookcheck.net', 'anandtech.com'],
  US: ['reddit.com', 'youtube.com', 'youtube.com'],
};

const MULTI_LABEL_TLDS = new Set([
  'co.uk', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'com.tw', 'com.sg', 'com.jp', 'co.jp', 'com.au',
]);

export function normalizeUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || '').toLowerCase());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const kept = new URLSearchParams();
  parsed.searchParams.forEach((value, key) => {
    if (!TRACKING_PARAM_RE.test(key)) kept.append(key, value);
  });

  const query = kept.toString();
  const cleanPath = parsed.pathname.replace(/\/+$/, '') || '/';
  const url = `${parsed.protocol}//${parsed.host}${cleanPath}${query ? `?${query}` : ''}`;
  return url;
}

export function domainOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

// Subdomains of the same company count as one independent domain
export function independentDomain(domain: string): string {
  const host = String(domain || '').toLowerCase().replace(/^www\./, '');
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join('.');
  if (MULTI_LABEL_TLDS.has(last2)) return labels.slice(-3).join('.');
  return last2;
}

export function countIndependentDomains(sources: FilteredSource[]): number {
  const domains = new Set<string>();
  for (const s of sources) domains.add(independentDomain(s.domain));
  return domains.size;
}

export function detectRegion(domain: string): string | null {
  const host = String(domain || '').toLowerCase();
  for (const [region, domains] of Object.entries(REGION_DOMAINS)) {
    for (const d of domains) {
      if (host === d || host.endsWith(`.${d}`)) return region;
    }
  }
  return null;
}

export function isOfficialDomain(domain: string): boolean {
  const host = String(domain || '').toLowerCase();
  if (KNOWN_OFFICIAL_DOMAINS.has(host)) return true;
  const labels = host.split('.');
  if (labels.length >= 2) {
    const last2 = labels.slice(-2).join('.');
    if (last2 === 'gov' || last2 === 'edu' || last2.startsWith('gov.')) return true;
  }
  return false;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'is', 'are', 'with',
  'what', 'which', 'how', 'does', 'do', 'does', 'please', 'vs', 'versus',
  'http', 'https', 'www', 'com', 'cn',
]);

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = String(text || '').toLowerCase();
  const wordRe = /[a-z0-9][a-z0-9+./-]*/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(normalized))) {
    const w = m[0].replace(/[./-]+$/, '');
    if (w.length >= 2 && !STOPWORDS.has(w)) tokens.add(w);
  }
  const cjkRe = /[一-鿿]+/g;
  let c: RegExpExecArray | null;
  while ((c = cjkRe.exec(normalized))) {
    const run = c[0];
    if (run.length === 1 && !STOPWORDS.has(run)) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

function recencyScore(publishedDate?: string): number {
  if (!publishedDate) return 0.5;
  const t = Date.parse(publishedDate);
  if (Number.isNaN(t)) return 0.5;
  const ageDays = (Date.now() - t) / 86_400_000;
  if (ageDays <= 30) return 1.0;
  if (ageDays <= 90) return 0.8;
  if (ageDays <= 365) return 0.5;
  return 0.2;
}

function queryOverlap(queryTokens: Set<string>, haystackTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  let hits = 0;
  for (const t of queryTokens) if (haystackTokens.has(t)) hits++;
  return hits / queryTokens.size;
}

export function filterSources(results: RawSourceResult[], opts: FilterOptions = {}): FilteredSource[] {
  const { query, region, maxPerDomain = 1 } = opts;
  const queryTokens = query ? tokenize(query) : new Set<string>();

  // Step 1-2: normalize + URL dedup
  const byUrl = new Map<string, FilteredSource & { recency: number; regionTag: string | null }>();
  for (const r of results ?? []) {
    const url = normalizeUrl(r.url);
    if (!url) continue;
    if (byUrl.has(url)) continue;

    const domain = r.domain || domainOfUrl(url);
    const isOfficial = isOfficialDomain(domain);
    const regionTag = detectRegion(domain);
    const recency = recencyScore(r.publishedDate);

    // Step 3: relevance scoring (keyword overlap; falls back to title/snippet self-overlap)
    const haystack = tokenize(`${r.title} ${r.snippet}`);
    const qo = queryTokens.size > 0 ? queryOverlap(queryTokens, haystack) : 0;
    const selfOverlap =
      queryTokens.size === 0
        ? queryOverlap(tokenize(r.title), new Set([...haystack]))
        : 0;
    const overlap = queryTokens.size > 0 ? qo : selfOverlap;

    let relevance = 0.6 * overlap + 0.25 * recency + (isOfficial ? 0.15 : 0);
    if (region) {
      if (regionTag === region) relevance += 0.2;
      else if (regionTag && regionTag !== region) relevance -= 0.15;
    }
    relevance = Math.max(0, Math.min(1, Math.round(relevance * 1000) / 1000));

    byUrl.set(url, {
      url,
      domain,
      title: String(r.title ?? '').trim(),
      snippet: String(r.snippet ?? '').trim(),
      isOfficial,
      relevance,
      recency,
      regionTag,
    });
  }

  // Step 4: domain dedup — keep the top N per exact domain
  const byDomain = new Map<string, (FilteredSource & { recency: number; regionTag: string | null })[]>();
  for (const s of byUrl.values()) {
    const list = byDomain.get(s.domain) ?? [];
    list.push(s);
    byDomain.set(s.domain, list);
  }

  const out: FilteredSource[] = [];
  for (const list of byDomain.values()) {
    list.sort((a, b) => b.relevance - a.relevance || b.recency - a.recency);
    for (const s of list.slice(0, Math.max(1, maxPerDomain))) {
      out.push({ url: s.url, domain: s.domain, title: s.title, snippet: s.snippet, isOfficial: s.isOfficial, relevance: s.relevance });
    }
  }

  out.sort((a, b) => b.relevance - a.relevance);
  return out;
}

export function selectTopSources(
  sources: FilteredSource[],
  minDomains: number,
  maxSources: number,
): FilteredSource[] {
  if (!sources || sources.length === 0) return [];
  const sorted = [...sources].sort((a, b) => b.relevance - a.relevance);
  const totalDomains = countIndependentDomains(sorted);

  const result: FilteredSource[] = [];
  const usedDomains = new Set<string>();
  const enforceDiversity = totalDomains >= minDomains && minDomains > 1;

  for (const s of sorted) {
    if (result.length >= maxSources) break;
    const idom = independentDomain(s.domain);
    if (enforceDiversity && usedDomains.size < minDomains && !usedDomains.has(idom)) {
      // While independent-domain coverage is below minDomains, only add new domains
      usedDomains.add(idom);
      result.push(s);
      continue;
    }
    if (enforceDiversity && usedDomains.size < minDomains) continue;
    usedDomains.add(idom);
    result.push(s);
  }
  return result;
}
