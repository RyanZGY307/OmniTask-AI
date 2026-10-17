// ================================================================
// Region Expression Habits — 地区级共享表达习惯聚合
// ================================================================
// 某 region 中 ≥70%「有表达画像」的用户共有的 active 表达习惯 → 标记为该
// region 共享，注入该地区用户（个人习惯优先级更高）。
// 口径：人数占比（distinct user / region total），最小样本 20 防小样本误判。

import { prisma } from './db';

const RATIO_THRESHOLD = 0.7;
const MIN_REGION_USERS = 20;

/**
 * 聚合单个 region 的共享表达习惯。
 * 分母 = 该 region 有 active ExpressionProfile 的用户数；
 * 分子 = 拥有某 (dimension, pattern) active 习惯的去重用户数。
 * ratio ≥ 0.7 且样本 ≥ 20 → active，否则 decayed。
 */
export async function aggregateRegionHabit(
  region: string,
): Promise<{ regionTotal: number; upserted: number; skipped: boolean }> {
  const users = await prisma.expressionProfile.findMany({
    where: { status: 'active', user: { region } },
    select: {
      userId: true,
      patterns: { where: { status: 'active' }, select: { dimension: true, pattern: true } },
    },
  });
  const regionTotal = users.length;
  if (regionTotal < MIN_REGION_USERS) {
    return { regionTotal, upserted: 0, skipped: true };
  }

  const byPattern = new Map<string, { dimension: string; pattern: string; users: Set<string> }>();
  for (const u of users) {
    for (const p of u.patterns) {
      const gkey = `${p.dimension}\u0000${p.pattern}`;
      let g = byPattern.get(gkey);
      if (!g) {
        g = { dimension: p.dimension, pattern: p.pattern, users: new Set() };
        byPattern.set(gkey, g);
      }
      g.users.add(u.userId);
    }
  }

  let upserted = 0;
  for (const g of byPattern.values()) {
    const userCount = g.users.size;
    const ratio = userCount / regionTotal;
    const active = ratio >= RATIO_THRESHOLD;
    await prisma.regionExpressionHabit.upsert({
      where: { region_dimension_pattern: { region, dimension: g.dimension, pattern: g.pattern } },
      create: {
        region,
        dimension: g.dimension,
        pattern: g.pattern,
        userCount,
        regionTotal,
        ratio: Math.round(ratio * 1000) / 1000,
        confidence: Math.min(0.95, 0.5 + ratio * 0.3),
        status: active ? 'active' : 'decayed',
      },
      update: {
        userCount,
        regionTotal,
        ratio: Math.round(ratio * 1000) / 1000,
        status: active ? 'active' : 'decayed',
      },
    });
    if (active) upserted++;
  }

  return { regionTotal, upserted, skipped: false };
}

/** 遍历所有出现过的 region 聚合一次。供 cron / admin 触发。 */
export async function aggregateAllRegions(): Promise<{ regions: string[]; upserted: number }> {
  const regionRows = await prisma.user.findMany({
    select: { region: true },
    distinct: ['region'],
    where: { region: { not: '' } },
  });
  let upserted = 0;
  const regions: string[] = [];
  for (const r of regionRows) {
    if (!r.region) continue;
    const out = await aggregateRegionHabit(r.region);
    regions.push(r.region);
    upserted += out.upserted;
  }
  return { regions, upserted };
}

/** 读取某 region 的 active 共享习惯（按 ratio 降序，限制条数）——供 prompt 注入。 */
export async function getRegionHabits(
  region: string,
  limit = 8,
): Promise<{ dimension: string; pattern: string }[]> {
  if (!region) return [];
  const rows = await prisma.regionExpressionHabit
    .findMany({
      where: { region, status: 'active' },
      orderBy: { ratio: 'desc' },
      take: limit,
    })
    .catch(() => []);
  return rows.map((r) => ({ dimension: r.dimension, pattern: r.pattern }));
}

/** 按 userId 查其 region 的共享习惯（内部查 User.region）。供 prompt 注入。 */
export async function getRegionHabitsForUser(
  userId: string,
  limit = 8,
): Promise<{ dimension: string; pattern: string }[]> {
  const u = await prisma.user
    .findUnique({ where: { id: userId }, select: { region: true } })
    .catch(() => null);
  if (!u?.region) return [];
  return getRegionHabits(u.region, limit);
}
