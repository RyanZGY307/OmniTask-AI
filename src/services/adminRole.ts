// ================================================================
// 环境变量管理员名单（ADMIN_USERNAMES）
// ================================================================
// 部署时在环境变量中配置逗号分隔的用户名名单；名单中的账号登录后自动视为
// 管理员（role 至少为 ADMIN，已是 SUPER_ADMIN 不降级）。这样无需改数据库，
// 前端侧栏仅对管理员显示的后台管理入口会自动对名单账号出现。

import { env } from '../config';

/** 用户名是否在 ADMIN_USERNAMES 名单中。 */
export function isEnvAdmin(username: string | null | undefined): boolean {
  if (!username) return false;
  return env.ADMIN_USERNAMES.includes(username);
}

/** 计算生效 role：名单内账号提升为 ADMIN（SUPER_ADMIN 保持不变）。 */
export function effectiveRole(username: string | null | undefined, role: string): string {
  if (role === 'SUPER_ADMIN') return role;
  if (isEnvAdmin(username)) return 'ADMIN';
  return role;
}
