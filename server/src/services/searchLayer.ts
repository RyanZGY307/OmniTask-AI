// ================================================================
// Search Layer — normalized web search via CSE / Tavily / DDG
// ================================================================

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  publishedDate?: string;
  /** Perplexity synthesized answer (present on the leading entry when the Perplexity engine is used). */
  answer?: string;
}

export type SearchEngine = 'auto' | 'perplexity' | 'tavily' | 'duckduckgo' | 'google';

export interface SearchOptions {
  domain?: string;
  region?: string;
  maxResults?: number;
  type?: 'web' | 'news' | 'video' | 'images';
  /** 按需使用指定搜索引擎；默认 'auto'（Perplexity→CSE→Tavily→DDG 兜底）。 */
  engine?: SearchEngine;
}

const SEARCH_TIMEOUT_MS = 15_000;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function googleCse(query: string, opts: SearchOptions): Promise<SearchResult[]> {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return [];

  const params = new URLSearchParams({
    key,
    cx,
    q: query,
    num: String(opts.maxResults ?? 10),
    searchType: opts.type ?? 'web',
  });
  if (opts.domain) params.set('siteSearch', opts.domain);
  if (opts.region) params.set('gl', opts.region);

  const res = await fetchWithTimeout(
    `https://www.googleapis.com/customsearch/v1?${params.toString()}`,
  );
  if (!res.ok) throw new Error(`Google CSE ${res.status}`);
  const data: any = await res.json();

  const items: SearchResult[] = (data.items ?? []).map((it: any) => ({
    title: it.title ?? '',
    url: it.link ?? '',
    snippet: it.snippet ?? '',
    domain: domainOf(it.link ?? ''),
    ...(it.pd_text ? { publishedDate: it.pd_text } : {}),
  }));
  return items.slice(0, opts.maxResults ?? 10);
}

async function tavily(query: string, opts: SearchOptions): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];

  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      query,
      max_results: opts.maxResults ?? 10,
      search_depth: 'basic',
      include_domains: opts.domain ? [opts.domain] : undefined,
      topic: opts.type === 'news' ? 'news' : 'general',
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data: any = await res.json();

  const items: SearchResult[] = (data.results ?? []).map((r: any) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
    domain: domainOf(r.url ?? ''),
    ...(r.published_date ? { publishedDate: r.published_date } : {}),
  }));
  return items.slice(0, opts.maxResults ?? 10);
}

async function duckDuckGo(query: string, opts: SearchOptions): Promise<SearchResult[]> {
  const q = opts.domain ? `site:${opts.domain} ${query}` : query;
  const res = await fetchWithTimeout(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
    },
  );
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();

  const items: SearchResult[] = [];
  const resultBlocks = html.split(/class="result results_links/);
  for (const block of resultBlocks.slice(1)) {
    const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/);
    if (!urlMatch) continue;
    let url = urlMatch[1];
    const redirect = url.match(/uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.includes('duckduckgo.com')) continue;

    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/);
    items.push({
      title: (titleMatch ? titleMatch[1] : '').replace(/<[^>]+>/g, '').trim(),
      url,
      snippet: (snippetMatch ? snippetMatch[1] : '').replace(/<[^>]+>/g, '').trim(),
      domain: domainOf(url),
    });
    if (items.length >= (opts.maxResults ?? 10)) break;
  }
  return items;
}

async function socpkDirect(query: string, opts: SearchOptions): Promise<SearchResult[]> {
  const res = await fetchWithTimeout(
    `https://www.socpk.com/search?q=${encodeURIComponent(query)}`,
    {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OmniTask/1.0)' },
    },
  );
  if (!res.ok) return [];
  const html = await res.text();

  const items: SearchResult[] = [];
  const linkRe = /<a[^>]+href="(https?:\/\/(?:www\.)?socpk\.com[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && items.length < (opts.maxResults ?? 10)) {
    const url = m[1];
    if (items.some((it) => it.url === url)) continue;
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    items.push({ title, url, snippet: '', domain: domainOf(url) });
  }
  return items;
}

async function perplexity(query: string, opts: SearchOptions): Promise<SearchResult[]> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return [];
  const model = process.env.PERPLEXITY_MODEL || 'sonar';
  // 免费版基础搜索：sonar + standard search_prompt_version，不用 pro/reasoning。
  const res = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: query }],
      search_prompt_version: 'standard',
    }),
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status}`);
  const data: any = await res.json();
  const synthesis: string = data?.choices?.[0]?.message?.content ?? '';
  const items: SearchResult[] = (data?.search_results ?? []).slice(0, opts.maxResults ?? 8).map((r: any) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: '',
    domain: domainOf(r.url ?? ''),
    ...(r.page_age ? { publishedDate: String(r.page_age) } : {}),
  }));
  if (synthesis) {
    items.unshift({
      title: 'Perplexity AI Summary',
      url: items[0]?.url || 'https://www.perplexity.ai/',
      snippet: synthesis,
      domain: 'perplexity.ai',
      answer: synthesis,
    });
  }
  return items;
}

export async function webSearch(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const engine: SearchEngine = opts.engine ?? 'auto';
  if (opts.domain === 'socpk.com') {
    return socpkDirect(query, opts);
  }

  // 按需指定引擎（'按需使用'）
  switch (engine) {
    case 'perplexity':
      try { return await perplexity(query, opts); } catch (err: any) { console.warn('[SearchLayer] Perplexity failed:', err?.message ?? err); }
      break;
    case 'tavily':
      try { return await tavily(query, opts); } catch (err: any) { console.warn('[SearchLayer] Tavily failed:', err?.message ?? err); }
      break;
    case 'duckduckgo':
      try { return await duckDuckGo(query, opts); } catch { return []; }
    case 'google':
      try { return await googleCse(query, opts); } catch { return []; }
    default:
      break;
  }

  // auto：Perplexity（若配置）→ Google CSE → Tavily → DuckDuckGo（无限兜底）
  let results: SearchResult[] | null = null;

  if (process.env.PERPLEXITY_API_KEY) {
    try {
      results = await perplexity(query, opts);
      if (results.length > 0) return results;
    } catch (err: any) {
      console.warn('[SearchLayer] Perplexity failed:', err?.message ?? err);
    }
  }

  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_ID) {
    try {
      results = await googleCse(query, opts);
      if (results && results.length > 0) return results;
    } catch (err: any) {
      console.warn('[SearchLayer] CSE failed:', err?.message ?? err);
    }
  }

  if (process.env.TAVILY_API_KEY) {
    try {
      results = await tavily(query, opts);
      if (results.length > 0) return results;
    } catch (err: any) {
      console.warn('[SearchLayer] Tavily failed:', err?.message ?? err);
    }
  }

  try {
    return await duckDuckGo(query, opts);
  } catch (err: any) {
    console.warn('[SearchLayer] DuckDuckGo failed:', err?.message ?? err);
    return [];
  }
}
