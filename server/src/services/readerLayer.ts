// ================================================================
// Reader Layer — web page content extraction
// ================================================================

export interface PageContent {
  url: string;
  title: string;
  text: string;
  images: string[];
  videos: string[];
  success: boolean;
  error?: string;
}

export interface ReadOptions {
  maxChars?: number;
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function absUrl(base: string, href: string): string {
  if (!href) return '';
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function extractImages(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /<img[^>]+src="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const u = absUrl(base, m[1]);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

function extractVideos(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /<(?:video|iframe)[^>]+src="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const u = absUrl(base, m[1]);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

function stripScripts(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

function extractText(html: string): string {
  const cleaned = stripScripts(html);
  const blocks = cleaned.match(
    /<(?:p|li|h1|h2|h3|h4|h5|h6|pre|blockquote)[^>]*>[\s\S]*?<\/(?:p|li|h1|h2|h3|h4|h5|h6|pre|blockquote)>/gi,
  );
  if (!blocks || blocks.length === 0) {
    return cleaned.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const lines = blocks.map((b) =>
    b
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return lines.filter((l) => l.length > 0).join('\n');
}

function relativeMedia(url: string, src: string): string {
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  try {
    return new URL(src, url).href;
  } catch {
    return src;
  }
}

async function readViaJina(url: string): Promise<PageContent | null> {
  const key = process.env.JINA_API_KEY;
  if (!key) return null;

  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    console.warn(`[ReaderLayer] Jina failed ${res.status}, falling back`);
    return null;
  }
  const data: any = await res.json();
  const raw = typeof data?.data?.content === 'string' ? data.data.content : data?.content;
  if (typeof raw !== 'string') return null;

  const title = String(data?.data?.title ?? '').trim();
  const images: string[] = [];
  const imgRe = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(raw))) {
    if (!images.includes(im[1])) images.push(im[1]);
  }
  const videos: string[] = [];
  const videoRe = /https?:\/\/[^\s"'<>)\]]*?\.(?:mp4|webm|mov)(?:\?[^\s"'<>)\]]*)?/gi;
  const vm = raw.match(videoRe);
  if (vm) {
    for (const u of vm) {
      if (!videos.includes(u)) videos.push(u);
    }
  }

  return {
    url,
    title,
    text: raw,
    images,
    videos,
    success: true,
  };
}

async function readViaFetch(url: string, opts: ReadOptions): Promise<PageContent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      return {
        url,
        title: '',
        text: '',
        images: [],
        videos: [],
        success: false,
        error: `HTTP ${res.status}`,
      };
    }
    const html = await res.text();

    const maxChars = opts.maxChars ?? 200_000;
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const source = bodyMatch ? bodyMatch[1] : html;

    const clean = extractText(source);
    let text = clean;
    if (text.length > maxChars) text = text.slice(0, maxChars);

    const finalUrl = res.url || url;
    const images = extractImages(source, finalUrl).map((u) => relativeMedia(finalUrl, u));
    const videos = extractVideos(source, finalUrl).map((u) => relativeMedia(finalUrl, u));

    return {
      url: finalUrl,
      title: extractTitle(html),
      text,
      images,
      videos,
      success: true,
    };
  } catch (err: any) {
    return {
      url,
      title: '',
      text: '',
      images: [],
      videos: [],
      success: false,
      error: String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function readPage(url: string, opts: ReadOptions = {}): Promise<PageContent> {
  const jina = await readViaJina(url);
  if (jina) {
    const maxChars = opts.maxChars ?? 200_000;
    if (jina.text.length > maxChars) jina.text = jina.text.slice(0, maxChars);
    return jina;
  }
  return readViaFetch(url, opts);
}
