// ================================================================
// 数据库连接串环境变量解析（纯函数，不依赖 Prisma，可独立测试）
// ================================================================
// 多数据库混合架构：每个域的连接串唯一来源 = 部署环境变量
// DATABASE_URL_<DOMAIN>（USER / CONVERSATION / KNOWLEDGE / OVERFLOW）。

export type DbDomain = 'user' | 'conversation' | 'knowledge' | 'overflow';

export const DB_DOMAINS: DbDomain[] = ['user', 'conversation', 'knowledge', 'overflow'];

/** 读取某个域的 DATABASE_URL_* 环境变量；未配置返回 null。 */
export function dbUrlFromEnv(domain: DbDomain): string | null {
  const v = process.env[`DATABASE_URL_${domain.toUpperCase()}`];
  return v && v.trim() ? v.trim() : null;
}

/** true 表示 user 库连接串未配置，业务路由应全部挡下（setup 模式）。 */
export function isDbSetupRequired(): boolean {
  return !dbUrlFromEnv('user');
}
