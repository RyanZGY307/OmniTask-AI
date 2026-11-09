// ================================================================
// quotaAudit — 三级额度自动切换审计（user 库 QuotaSwitchLog）。
//
// 口径：只在「数据额度限制」触发的自动切换时写一条（用户 m02000 答复），
// 记录触发层级、额度类型、原 API/模型、目标 API/模型、切换原因、剩余额度。
// 非额度类失败（并发满/超时/5xx/401/403/参数错）不写、也不允许切换。
//
// 写表失败绝不影响调用链：只打日志，不抛。
// ================================================================
import { prisma, isDbSetupRequired } from './db';

export interface QuotaSwitchRecord {
  /** 触发层级：api / carrier / model */
  level: 'api' | 'carrier' | 'model';
  /** 额度类型：rpm / tpm / rpd / tpd / max_parallel / rate_limit / quota_limit */
  quotaType: string;
  fromApi: string;
  toApi: string;
  fromModel: string;
  toModel: string;
  reason: string;
  /** 切换后剩余额度快照（JSON 字符串，脱敏后） */
  remaining?: string;
}

/** 记录一次额度类自动切换。静默失败（审计不可阻断业务）。 */
export async function recordQuotaSwitch(rec: QuotaSwitchRecord): Promise<boolean> {
  try {
    if (!isDbSetupRequired()) return false;
    await prisma.quotaSwitchLog.create({
      data: {
        level: rec.level,
        quotaType: rec.quotaType,
        fromApi: rec.fromApi,
        toApi: rec.toApi,
        fromModel: rec.fromModel || '*',
        toModel: rec.toModel || '*',
        reason: rec.reason,
        remaining: rec.remaining || '{}',
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** 查询最近的切换记录（管理端审计用）；DB 不可用时返回空数组。 */
export async function recentQuotaSwitches(limit = 50): Promise<Array<{
  id: string; level: string; quotaType: string; fromApi: string; toApi: string;
  fromModel: string; toModel: string; reason: string; createdAt: Date;
}>> {
  try {
    if (!isDbSetupRequired()) return [];
    const rows = await prisma.quotaSwitchLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(200, limit)),
      select: {
        id: true, level: true, quotaType: true, fromApi: true, toApi: true,
        fromModel: true, toModel: true, reason: true, createdAt: true,
      },
    });
    return rows;
  } catch {
    return [];
  }
}
