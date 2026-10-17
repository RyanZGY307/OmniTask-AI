// ================================================================
// Media Analysis — image/video analysis with pluggable provider
// Media observations are always tagged VISUAL_OBSERVATION or
// MEASURED_RESULT; they are never auto-promoted to OFFICIAL_FACT.
// ================================================================

import { prismaKnowledge } from './db';

export interface ImageObservation {
  description: string;
  observationType: string;
  confidence: number;
}

export interface ImageAnalysis {
  observations: ImageObservation[];
  measurements?: Record<string, string>;
}

export interface VideoSegment {
  start: number;
  end: number;
  description: string;
  observations: string[];
  measurements?: Record<string, string>;
}

export interface VideoAnalysis {
  segments: VideoSegment[];
  transcript?: string;
}

export interface MediaAnalysisProvider {
  analyzeImage(url: string, context: string): Promise<ImageAnalysis>;
  analyzeVideo(url: string, context: string): Promise<VideoAnalysis>;
}

export class DefaultMediaProvider implements MediaAnalysisProvider {
  async analyzeImage(url: string, context: string): Promise<ImageAnalysis> {
    console.log(`[MediaAnalysis] DefaultMediaProvider: image VLM not wired up yet; returning empty result (url=${url}, context="${context}")`);
    return { observations: [] };
  }

  async analyzeVideo(url: string, context: string): Promise<VideoAnalysis> {
    console.log(`[MediaAnalysis] DefaultMediaProvider: video VLM not wired up yet; returning empty result (url=${url}, context="${context}")`);
    return { segments: [] };
  }
}

let mediaProvider: MediaAnalysisProvider = new DefaultMediaProvider();

export function setMediaProvider(provider: MediaAnalysisProvider): void {
  mediaProvider = provider;
}

export async function analyzeImages(urls: string[], context: string, maxImages = 10): Promise<ImageAnalysis[]> {
  const batch = (Array.isArray(urls) ? urls : [])
    .filter((u): u is string => Boolean(u))
    .slice(0, maxImages);
  return Promise.all(
    batch.map((url) =>
      mediaProvider.analyzeImage(url, context).catch((err: any) => {
        console.warn(`[MediaAnalysis] analyzeImage failed for ${url}: ${err?.message ?? err}`);
        return { observations: [] };
      }),
    ),
  );
}

export async function analyzeVideos(urls: string[], context: string, maxVideos = 3): Promise<VideoAnalysis[]> {
  const batch = (Array.isArray(urls) ? urls : [])
    .filter((u): u is string => Boolean(u))
    .slice(0, maxVideos);
  return Promise.all(
    batch.map((url) =>
      mediaProvider.analyzeVideo(url, context).catch((err: any) => {
        console.warn(`[MediaAnalysis] analyzeVideo failed for ${url}: ${err?.message ?? err}`);
        return { segments: [] };
      }),
    ),
  );
}

export interface MediaPayload {
  type: 'IMAGE' | 'VIDEO';
  url: string;
  sourceTitle?: string;
  analysis: any;
}

export async function createMediaReference(
  objectId: string,
  researchRecordId: string | null,
  media: MediaPayload,
): Promise<string> {
  const analysis = media?.analysis ?? {};
  const observations: any[] = Array.isArray(analysis.observations) ? analysis.observations : [];
  const hasMeasurements = Boolean(analysis.measurements) && Object.keys(analysis.measurements).length > 0;

  let observationType: string = hasMeasurements ? 'MEASURED_RESULT' : 'VISUAL_OBSERVATION';
  const declared = String(observations[0]?.observationType ?? analysis.observationType ?? '').toUpperCase();
  if (declared === 'MEASURED_RESULT' || declared === 'VISUAL_OBSERVATION') {
    observationType = declared;
  }

  const segments: any[] = Array.isArray(analysis.segments) ? analysis.segments : [];
  const numOrNull = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const timestampStart = numOrNull(segments.length > 0 ? segments[0]?.start : null);
  const timestampEnd = numOrNull(segments.length > 0 ? segments[segments.length - 1]?.end : null);

  const ref = await prismaKnowledge.mediaReference.create({
    data: {
      objectId,
      researchRecordId: researchRecordId ?? null,
      mediaType: media.type,
      sourceUrl: media.url,
      sourceTitle: media.sourceTitle ?? null,
      observationType,
      observation: observations.length > 0 ? JSON.stringify(observations) : (analysis.summary ? String(analysis.summary) : null),
      measurementJson: hasMeasurements ? JSON.stringify(analysis.measurements) : null,
      analysisResult: JSON.stringify(analysis).slice(0, 20000),
      timestampStart,
      timestampEnd,
      sourceAttribution: media.sourceTitle ?? null,
    },
  });
  return ref.id;
}
