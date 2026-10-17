// ================================================================
// Variant Resolver — pick the right variant of a knowledge object
// ================================================================

import { prismaKnowledge } from './db';

export interface ResolveVariantOpts {
  region?: string;
  country?: string;
  market?: string;
  variantName?: string;
  modelNumber?: string;
  userRegion?: string;
}

export interface CandidateVariantInput {
  region?: string;
  country?: string;
  market?: string;
  variantName?: string;
  modelNumber?: string;
}

export async function findVariant(
  objectId: string,
  region?: string,
  variantName?: string,
): Promise<any | null> {
  const where: Record<string, any> = { objectId };
  if (region) where.region = region;
  if (variantName) where.variantName = variantName;

  const confirmed = await prismaKnowledge.knowledgeVariant.findFirst({
    where: { ...where, status: 'CONFIRMED' },
  });
  if (confirmed) return confirmed;

  return prismaKnowledge.knowledgeVariant.findFirst({
    where,
    orderBy: { createdAt: 'asc' },
  });
}

export async function createCandidateVariant(
  objectId: string,
  data: CandidateVariantInput,
): Promise<any> {
  try {
    return await prismaKnowledge.knowledgeVariant.create({
      data: {
        objectId,
        region: data.region ?? null,
        country: data.country ?? null,
        market: data.market ?? null,
        variantName: data.variantName ?? null,
        modelNumber: data.modelNumber ?? null,
        status: 'CANDIDATE',
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      const retry = await findVariant(objectId, data.region, data.variantName);
      if (retry) return retry;
    }
    throw err;
  }
}

// Priority: user-specified variant > user region > global/international > new CANDIDATE
export async function resolveVariant(
  objectId: string,
  opts?: ResolveVariantOpts,
): Promise<any> {
  const explicit = await findVariant(objectId, opts?.region, opts?.variantName);
  if (explicit) return explicit;

  if (opts?.userRegion) {
    const byUserRegion = await findVariant(objectId, opts.userRegion);
    if (byUserRegion) return byUserRegion;
  }

  const global = await findVariant(objectId);
  if (global) return global;

  return createCandidateVariant(objectId, {
    region: opts?.region || opts?.userRegion,
    country: opts?.country,
    market: opts?.market,
    variantName: opts?.variantName,
    modelNumber: opts?.modelNumber,
  });
}
