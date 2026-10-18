// ================================================================
// Client Presence — 哪些前端标签页此刻是活的。
// ================================================================
// 待命连接需求：只要前端处于运行状态，后端与 4 个 Postgres 池就必须保持
// 温热，用户发出第一条消息时才不会撞上冷连接重建（10-30s 停顿）。
//
// 每个可见的前端标签页按固定 per-tab id 心跳；本模块是服务端登记表。
// 存活状态驱动 DB 保活节奏（见 db.startKeepAlive）：有客户端存活时收紧，
// 无人看守时放宽，空转的服务不白烧查询。
//
// 纯进程内、零依赖、不碰数据库，因此可在任何环境单测。
//
// TTL 边界：超过 PRESENCE_TTL_MS 没有心跳的标签页（关闭、崩溃、断网）
// 不再计入存活，所以"存活"状态不可能被永久卡在开启位——一个忘了反注册
// 的客户端最多让保活多跑一个 TTL 周期，随后自动回落。
// ================================================================

/** 距上次心跳在该时间内 → 视为存活。必须大于前端待命轮询间隔。 */
export const PRESENCE_TTL_MS = 45_000;
/** 有客户端存活时的 DB ping 节奏（待命） */
export const KEEPALIVE_ACTIVE_MS = 15_000;
/** 无人看守时的 DB ping 节奏（保持既有行为，不更慢） */
export const KEEPALIVE_IDLE_MS = 60_000;

/** 客户端 id 的合法形态。前端生成 `tab_<base36>_<6位>`；其余一律拒绝。 */
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * 登记表硬上限。X-Client-Id 是未认证的请求头，任何人都能带任意值打
 * /api/health；没有上限时，刷唯一 id 就能让这张表无界增长（内存 DoS）。
 * 合法浏览器标签页远远达不到这个量级。
 */
export const MAX_PRESENCE_ENTRIES = 5_000;

const clients = new Map<string, number>();

/**
 * 登记/刷新一个客户端。
 * 拒绝空 id（无名心跳不得把存活位顶起来）、拒绝超长/含异常字符的 id，
 * 以及表已满时的新 id（已有 id 仍可刷新）。
 */
export function touchClient(id: string, now: number = Date.now()): void {
  const key = String(id ?? '').trim();
  if (!CLIENT_ID_RE.test(key)) return;
  if (!clients.has(key) && clients.size >= MAX_PRESENCE_ENTRIES) return;
  clients.set(key, now);
}

export function activeClients(ttlMs: number = PRESENCE_TTL_MS, now: number = Date.now()): string[] {
  const out: string[] = [];
  for (const [id, lastSeen] of clients) {
    if (now - lastSeen <= ttlMs) out.push(id);
  }
  return out;
}

export function activeClientCount(ttlMs: number = PRESENCE_TTL_MS, now: number = Date.now()): number {
  return activeClients(ttlMs, now).length;
}

/** 清理过期条目，返回清理数。 */
export function pruneClients(ttlMs: number = PRESENCE_TTL_MS, now: number = Date.now()): number {
  let removed = 0;
  for (const [id, lastSeen] of clients) {
    if (now - lastSeen > ttlMs) {
      clients.delete(id);
      removed++;
    }
  }
  return removed;
}

export function dropClient(id: string): boolean {
  return clients.delete(String(id ?? '').trim());
}

/** 给定存活客户端数，返回 DB 保活应采用间隔（ms）。 */
export function keepAliveIntervalMs(activeCount: number): number {
  return activeCount > 0 ? KEEPALIVE_ACTIVE_MS : KEEPALIVE_IDLE_MS;
}

/** 仅供测试：清空登记表。 */
export function resetPresence(): void {
  clients.clear();
}
