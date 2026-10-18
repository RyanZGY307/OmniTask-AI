// ================================================================
// 待命连接（standby）—— 前端运行期间与后端/数据库保持温热的共享常量与工具。
// ================================================================
// 需求：只要前端处于运行状态，就与后端、数据库保持连接待命，以获取更快响应。
//
// 三个动作：
//   1. 可见时周期性心跳 /api/health（服务端会 ping 4 个 Postgres）；
//   2. 心跳带 X-Client-Id，让服务端知道"此刻有前端在岗"，从而把 DB 保活
//      从 60s 收紧到 15s（见 server/src/services/clientPresence.ts）；
//   3. 标签页隐藏或离线时暂停心跳，恢复可见/联网立刻补一次——后台标签页
//      不属于"运行状态"，持续轮询只会白烧电量与流量。
// ================================================================

/** 待命心跳间隔：可见且已连通时的后台节奏 */
export const STANDBY_POLL_MS = 20_000;
/** 失败重试间隔（沿用原 ConnectionGate 的 5s，连接未建立时不能慢） */
export const RETRY_POLL_MS = 5_000;
/** 与服务端 PRESENCE_TTL_MS 对齐：必须小于它，否则服务端会判我们掉线 */
export const PRESENCE_TTL_MS = 45_000;

const CLIENT_ID_KEY = 'cortex_client_id';

/**
 * 存储不可用时的兜底 id。必须按模块缓存：否则每条心跳都会生成一个新 id，
 * 服务端会把每一次心跳当成一个新标签页登记，存活计数被无谓条目撑大。
 */
let fallbackClientId: string | null = null;

/**
 * 每个标签页一个稳定 id。
 * sessionStorage 按标签页隔离：同源多标签页各自算一个存活客户端，刷新不换 id；
 * 不可用时（隐私模式/禁用存储）退回模块级内存 id，本标签页生命周期内保持稳定。
 */
export function getClientId(): string {
  if (typeof window === 'undefined') return '';
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const created = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    if (!fallbackClientId) {
      fallbackClientId = `tab_mem_${Math.random().toString(36).slice(2, 10)}`;
    }
    return fallbackClientId;
  }
}

/** 当前是否应该发心跳：标签页可见 且 浏览器在线。 */
export function isStandbyEligible(): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return document.visibilityState === 'visible';
}

/**
 * API origin（用于 preconnect 省掉首请求的 DNS/TCP/TLS）。
 * 同源部署（相对路径 /api）返回 null。SSR 与客户端都可安全调用。
 */
export function apiOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_API_URL;
  if (!raw || raw.startsWith('/')) return null; // 同源相对路径，无需 preconnect
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}
