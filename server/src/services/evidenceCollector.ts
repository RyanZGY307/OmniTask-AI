// ================================================================
// Evidence Collector — collect structured evidence from filtered sources
// ================================================================

import { prismaKnowledge } from './db';
import { readPage, type PageContent } from './readerLayer';
import type { FilteredSource } from './sourceFilter';

export interface CollectedEvidence {
  sourceId: string;
  url: string;
  domain: string;
  evidenceType: string;
  content: string;
  observedAt: Date;
  metadata: Record<string, any>;
}

export interface CollectOptions {
  maxChars?: number;
  timeout?: number;
  // Hard cap on sources per research job (the caller is expected to keep this at 12 or below)
  limit?: number;
}

const DEFAULT_MAX_SOURCES = 12;
const DEFAULT_MAX_CHARS = 20_000;
const DB_CONTENT_LIMIT = 20_000;

function detectEvidenceType(page: PageContent, text: string): string {
  if (!text) return 'TEXT';
  const numericDense = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).length > 10;
  const measurementish = /\b(benchmark|score|fps|watt|℃|°C|V\/mA|GB\/s|MHz|GHz|ms|nm)\b/i.test(text);
  if (numericDense && measurementish) return 'MEASUREMENT';
  return 'TEXT';
}

export async function collectEvidence(
  sources: FilteredSource[],
  researchRecordId: string,
  variantId?: string,
  opts: CollectOptions = {},
): Promise<CollectedEvidence[]> {
  const limit = opts.limit ?? DEFAULT_MAX_SOURCES;
  const batch = (sources ?? []).slice(0, limit);
  if (batch.length === 0) return [];

  // Phase 1: read all pages (in memory), in parallel
  const pages = await Promise.all(
    batch.map(async (s) => {
      const page = await readPage(s.url, {
        maxChars: opts.maxChars ?? DEFAULT_MAX_CHARS,
        timeout: opts.timeout,
      });
      return { source: s, page };
    }),
  );

  const readable = pages.filter((p) => p.page.success && p.page.text.trim().length > 0);

  // Phase 2: batch write in one transaction
  const collected: CollectedEvidence[] = await prismaKnowledge.$transaction(async (tx) => {
    const out: CollectedEvidence[] = [];

    for (const { source, page } of readable) {
      const content = String(page.text || '').slice(0, DB_CONTENT_LIMIT);
      const observedAt = new Date();

      const es = await tx.evidenceSource.upsert({
        where: { canonicalUrl: source.url },
        create: {
          canonicalUrl: source.url,
          domain: source.domain,
          title: page.title || source.title || null,
          sourceType: source.isOfficial ? 'OFFICIAL' : 'WEB',
          isOfficial: source.isOfficial,
          qualityScore: source.relevance,
        },
        update: {
          retrievedAt: observedAt,
        },
      });

      const metadata: Record<string, any> = {
        title: page.title || source.title || '',
        isOfficial: source.isOfficial,
        relevance: source.relevance,
        imagesCount: page.images.length,
        videosCount: page.videos.length,
        pageUrl: page.url,
      };

      const ev = await tx.evidence.create({
        data: {
          sourceId: es.id,
          researchRecordId: researchRecordId || null,
          variantId: variantId || null,
          content,
          evidenceType: detectEvidenceType(page, content),
          observedAt,
          metadataJson: JSON.stringify(metadata),
        },
      });

      out.push({
        sourceId: es.id,
        url: source.url,
        domain: source.domain,
        evidenceType: ev.evidenceType,
        content: ev.content,
        observedAt: ev.observedAt,
        metadata,
      });
    }

    return out;
  });

  const skipped = batch.length - collected.length;
  if (skipped > 0) {
    console.warn(`[EvidenceCollector] ${skipped}/${batch.length} sources skipped (read failure or empty text)`);
  }
  return collected;
}
