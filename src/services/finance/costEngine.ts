// ================================================================
// Cost Engine — 套餐价格作为成本基数（R2）
// ================================================================
//
// 成本来源：套餐/订阅的 USD 价格 × 固定汇率 4.50 × 保护系数 1.15
// 无需真实 Provider API 成本数据（ fictional models）
// ================================================================

import { Prisma } from '@prisma/client-user';
import { d, roundUsd } from './money';

export interface CostBreakdown {
  reviewRequired: boolean;
  reason?: string;
  packageId?: string;
  priceUsd: Prisma.Decimal;
  protectedCostMyr: Prisma.Decimal;
}

/**
 * 计算某个套餐的保护成本（MYR）
 * @param priceUsd 套餐价格（USD）
 * @param protectionFactor 保护系数（默认 1.15）
 * @param costFxRate 固定汇率（默认 4.50）
 */
export function computePackageCost(
  priceUsd: Prisma.Decimal | number | string,
  protectionFactor = 1.15,
  costFxRate = 4.50,
): CostBreakdown {
  const price = d(priceUsd);
  const protectedCostMyr = price
    .times(protectionFactor)
    .times(costFxRate);
  return {
    reviewRequired: false,
    priceUsd: price,
    protectedCostMyr,
  };
}

/**
 * 计算毛利率
 * @param revenueUsd 收入（USD）
 * @param marketRate 市场汇率 USD/MYR
 * @param costMyr 成本（MYR）
 */
export function computeMargin(
  revenueUsd: Prisma.Decimal | number | string,
  marketRate: Prisma.Decimal | number | string,
  costMyr: Prisma.Decimal | number | string,
): Prisma.Decimal {
  const revenue = d(revenueUsd).times(d(marketRate));
  const cost = d(costMyr);
  if (revenue.lte(0)) return new Prisma.Decimal(0);
  return revenue.minus(cost).div(revenue);
}

/**
 * 从套餐列表计算整体毛利率
 * @param packages 套餐列表 { id, priceUsd }
 * @param marketRate 市场汇率
 */
export function computePortfolioMargin(
  packages: Array<{ id: string; priceUsd: Prisma.Decimal | number | string }>,
  marketRate: Prisma.Decimal | number | string,
): Prisma.Decimal {
  if (packages.length === 0) return new Prisma.Decimal(0);

  let totalRevenueMyr = new Prisma.Decimal(0);
  let totalCostMyr = new Prisma.Decimal(0);

  for (const pkg of packages) {
    const price = d(pkg.priceUsd);
    totalRevenueMyr = totalRevenueMyr.plus(price.times(d(marketRate)));
    totalCostMyr = totalCostMyr.plus(price.times(1.15).times(4.50));
  }

  return computeMargin(totalRevenueMyr, 1, totalCostMyr);
}
