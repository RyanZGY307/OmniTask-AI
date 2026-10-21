// ================================================================
// System Setup — 首次配置：连接串由管理页填写，不读部署环境变量
// ================================================================
// 对应需求：数据库连接串不再从部署平台环境变量读取，而是与 API 一起在
// 后端 API 管理页面填入。这里提供「还没有任何配置时」的唯一入口。
//
// 安全边界（关键）：
//   · setup 端点**只允许在 truly-unconfigured 状态下写**；一旦已有配置，
//     本路由全部返回 409，改配置必须走 admin 的 /models 同权端点。
//   · 单文件写、不并发：validateConnectionUrl 先行，再真实 connect 验证，
//     最后才落盘。任一环节失败都不落盘，也不会留下半份配置。
//   · GET 只回掩码，绝不回传可用连接串。
//   · 连接验证用一次性 PrismaClient + SELECT 1，不污染常驻连接池。
// ================================================================

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client-user';
import type { AuthRequest } from '../middleware/auth';
import { authMiddleware, adminAuth } from '../middleware/auth';
import {
  isSetupRequired, writeDbConnection, maskedDbConnections, reloadSystemConfig,
  validateConnectionUrl, DB_DOMAINS, maskUrl,
  type DbDomain, type UrlCheck,
} from '../services/systemConfig';

/** UrlCheck → 错误原因；ok 时返回 null，可安全用于 if 分支。 */
function urlErr(c: UrlCheck): string | null {
  return c.ok ? null : c.reason;
}

const router = Router();

// 未配置时：setup 状态可匿名查询（否则前端无法判断该显示登录页还是配置页）。
router.get('/status', async (_req: AuthRequest, res: Response) => {
  const required = isSetupRequired();
  res.json({
    setupRequired: required,
    configured: !required,
    dbDomains: DB_DOMAINS,
    connections: required ? [] : maskedDbConnections(),
  });
});

// 已配置后，任何 setup 写入都拒绝：防止把"改配置"变成绕过审计的无门槛入口。
router.use((req: AuthRequest, res: Response, next: any) => {
  if (!isSetupRequired()) {
    return res.status(409).json({ error: '系统已配置。修改连接串请使用管理端受权接口。' });
  }
  next();
});

// 真正写库：需要 admin 身份（首配时若尚无 admin 账号，允许 bootstrap 账号）。
router.post('/db-connections', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { domain, url, label } = req.body || {};
    if (!DB_DOMAINS.includes(domain)) {
      return res.status(400).json({ error: `domain 必须是 ${DB_DOMAINS.join('/')}` });
    }
    const check = validateConnectionUrl(url);
    // 用显式守卫而非依赖控制流窄化：UrlCheck 是区分联合，但在本项目的
    // tsconfig 下 `if (!check.ok)` 未被收窄，直接取 reason 会报 TS2339。
    // 守卫函数在任何 strict 配置下行为一致，也让调用点读起来更直接。
    const urlReason = urlErr(check);
    if (urlReason) return res.status(400).json({ error: urlReason });

    // 连通性验证：语法合法不等于可达。不通过就不落盘。
    let testUrl = String(url).trim();
    // 连接池参数极可能不在管理页输入里，补默认值以防被 provider 拒绝
    if (!/[?&]connection_limit=/.test(testUrl)) testUrl += (testUrl.includes('?') ? '&' : '?') + 'connection_limit=1&pool_timeout=20';

    const client = new PrismaClient({
      datasources: { db: { url: testUrl } },
      log: ['error'],
    });
    try {
      await client.$connect();
      await client.$queryRawUnsafe('SELECT 1 AS ok');
    } catch (e: any) {
      return res.status(400).json({ error: `连接失败：${e?.message || '不可达'}` });
    } finally {
      await client.$disconnect().catch(() => {});
    }

    await writeDbConnection({ domain: domain as DbDomain, url: String(url).trim(), label });
    await reloadSystemConfig();

    // 落盘 user 域后，其余域必须补齐——否则下次启动仍是残缺 setup。
    res.json({ success: true, domain, setupStillRequired: isSetupRequired() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || '写入失败' });
  }
});

// 管理端查当前连接串（掩码）——已配置时也可由 adminAuth 读取现状
router.get('/db-connections', authMiddleware, adminAuth, async (_req: AuthRequest, res: Response) => {
  res.json({ connections: maskedDbConnections(), maskExample: maskUrl('postgresql://u:secret@db.example.com:5432/cortex_user') });
});

export default router;
