// ================================================================
// 后台管理页六位密码校验（纯函数，可独立测试）
// ================================================================
// 进入 /admin 除管理员身份外，还需输入部署环境变量 ADMIN_ACCESS_PIN
// 中的六位数密码。比对使用 timingSafeEqual，避免时序侧信道。

import crypto from 'crypto';

export type PinCheckResult = 'ok' | 'wrong' | 'unconfigured';

export function checkAdminPin(pin: unknown): PinCheckResult {
  const configured = process.env.ADMIN_ACCESS_PIN || '';
  if (!configured) return 'unconfigured';
  const p = String(pin ?? '');
  if (!/^\d{6}$/.test(p)) return 'wrong';
  const a = Buffer.from(p);
  const b = Buffer.from(configured);
  // 长度不一致时仍做一次等长比较，避免时序侧信道
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? 'ok' : 'wrong';
}
