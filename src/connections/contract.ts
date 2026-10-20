// ================================================================
// Unified Connector Result Contract (P0)
// ----------------------------------------------------------------
// 为什么要有这个文件：
//
// 旧契约是 `ConnectorResult { ok: boolean; verified?; data?; error? }`。
// `error` 在成功分支是可选的，于是「健康检查返回 ok:true 同时带
// error: 'HTTP 200 at ...'」在类型上完全合法。实际代码里已经出现：
//   - mcp.ts:180-186   成功分支写 error 字段
//   - oauth.ts:278     成功分支写 error 字段
//   - plugin.ts:103    ok:true + 硬编码 latencyMs:10 + "(simulated)"
//   - browser.ts:325   ok:true + 硬编码 latencyMs:50，不发任何请求
//   - mcp.ts:86        发现失败返回 { tools: [], ok: true, error }
//
// 后果：按 `ok` 判定的调用方把失败当成功；按 `error` 非空判定的调用方把
// 成功当失败。两种判定都不可信，健康/诊断 UI 失去运维依据。
//
// 新契约用判别联合（discriminated union）让这些状态不可表示：
//   - 成功分支没有 `error` 字段
//   - 失败分支必须带 `error`
//   - `latencyMs` 只存在于健康结果，且由调用方实测传入
//   - `not_implemented` / `unavailable` 与 `success` 是不同 status
// ================================================================

/** 工具执行的统一结果分类。 */
export type ResultStatus =
  | 'success'          // 明确成功
  | 'failure'          // 明确失败（可归因）
  | 'not_implemented'  // 能力未实现 —— 必须保持独立状态，不得用 success 替代
  | 'unavailable'      // 当前环境/策略不支持（如本地 stdio 无隔离）
  | 'timeout'          // 超时
  | 'unknown'          // 结果未知（外部副作用不确定，不得归为明确失败）
  | 'partial'          // 部分成功
  | 'denied'           // 权限拒绝
  | 'auth_required';   // 需要（重新）授权

/** 成功结果：没有 error 字段。 */
export interface ResultSuccess {
  status: 'success';
  data?: any;
  /** 是否已对外部副作用做事后核实；未提供视为未核实。 */
  verified?: boolean;
}

/** 非成功结果：必须带 error，且 error 不得为空串。 */
export interface ResultNonSuccess {
  status: Exclude<ResultStatus, 'success'>;
  error: string;
  data?: any;
  verified?: false;
}

export type ConnectorResult = ResultSuccess | ResultNonSuccess;

// ----------------------------------------------------------------
// 工具发现的结果分类
// 用户的硬规则：「发现不到工具不等于发现成功」。
// 必须能区分：成功发现零个工具 / 发现失败 / 协议不兼容 / 连接失败 /
//             授权不足 / 未配置 / 超时。
// ----------------------------------------------------------------
export type DiscoveryStatus =
  | 'ok'                    // 发现成功；tools.length 可能为 0（这是合法结果）
  | 'protocol_incompatible' // 服务器不是 MCP 或不支持所需能力
  | 'connection_failed'     // 网络/连接层失败
  | 'auth_failed'           // 授权不足或凭据失效
  | 'not_configured'        // 缺少必要配置（如 serverUrl）
  | 'timeout'
  | 'unsupported';          // 本连接器类型不支持发现

export interface DiscoveryResult {
  status: DiscoveryStatus;
  tools: DiscoveredToolRef[];
  /** 诊断信息；仅在 status !== 'ok' 时必然存在。 */
  detail?: string;
  /** 服务器声明的协议/能力信息（若探测到）。 */
  serverInfo?: { name?: string; version?: string; protocolVersion?: string };
}

/** 发现到的工具的最小引用。Schema 与指纹在 Tool Registry 落库时补齐。 */
export interface DiscoveredToolRef {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
  /** 服务器自报的风险提示（仅作索引，不作为授权依据）。 */
  annotations?: Record<string, any>;
}

/** 健康检查结果：healthy 分支没有 error/detail 之外的失败字段。 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface HealthResult {
  status: HealthStatus;
  /** 实测延迟；没有真实测量就不要填。 */
  latencyMs?: number;
  /** 失败/降级原因；only for unhealthy/degraded。 */
  detail?: string;
  /** 探测用的端点（诊断用）。 */
  endpoint?: string;
}

// ----------------------------------------------------------------
// 构造器：统一的短路写法，避免各处手写字面量时漏字段或写错字段
// ----------------------------------------------------------------
export const R = {
  success(data?: any, verified?: boolean): ConnectorResult {
    const r: ResultSuccess = { status: 'success' };
    if (data !== undefined) r.data = data;
    if (verified !== undefined) r.verified = verified;
    return r;
  },

  fail(error: string, data?: any): ConnectorResult {
    if (!error || !error.trim()) {
      throw new Error('R.fail: error message is required and cannot be empty');
    }
    return { status: 'failure', error, ...(data !== undefined ? { data } : {}) };
  },

  denied(error: string): ConnectorResult {
    return { status: 'denied', error: error || 'Permission denied' };
  },

  notImplemented(what: string, extra?: Record<string, any>): ConnectorResult {
    return {
      status: 'not_implemented',
      error: `Not implemented: ${what}`,
      ...(extra ? { data: extra } : {}),
    };
  },

  unavailable(why: string, extra?: Record<string, any>): ConnectorResult {
    return { status: 'unavailable', error: `Unavailable: ${why}`, ...(extra ? { data: extra } : {}) };
  },

  timeout(what: string, afterMs?: number, extra?: Record<string, any>): ConnectorResult {
    return {
      status: 'timeout',
      error: `Timeout: ${what}${afterMs ? ` after ${afterMs}ms` : ''}`,
      ...(extra ? { data: extra } : {}),
    };
  },

  unknown(why: string, extra?: Record<string, any>): ConnectorResult {
    return {
      status: 'unknown',
      error: `Result unknown: ${why}`,
      ...(extra ? { data: extra } : {}),
    };
  },

  partial(data: any, error: string): ConnectorResult {
    return { status: 'partial', data, error };
  },
} as const;

/** 判断是否成功。单一 status 字段，不再看 error。 */
export function isSuccess(r: ConnectorResult): r is ResultSuccess {
  return r.status === 'success';
}

/**
 * 是否可安全重试。
 * 只有明确无副作用的暂时性失败才允许无条件重试；
 * 明确失败的用户侧错误、权限拒绝、取消、外部结果未知都不得重试。
 */
export function isRetryable(r: ConnectorResult): boolean {
  if (r.status === 'success') return false;
  // 结果未知：外部副作用不确定，重试可能重复操作。
  if (r.status === 'unknown') return false;
  if (r.status === 'denied' || r.status === 'auth_required') return false;
  if (r.status === 'not_implemented' || r.status === 'unavailable') return false;
  // 超时可能是客户端侧中断，外部可能已执行 —— 交由调用方结合幂等性决定。
  if (r.status === 'timeout') return false;
  // 仅剩 'failure' 与 'partial'：由调用方按错误分类进一步判断。
  return true;
}

/** 旧契约 → 新契约适配器。仅用于过渡，新代码不得再用旧形状。 */
export function fromLegacy(legacy: { ok: boolean; error?: string; data?: any; verified?: boolean }): ConnectorResult {
  if (legacy.ok && legacy.error) {
    // 历史脏数据：成功却带 error。以 ok 为准，丢弃不可信的 error。
    return R.success(legacy.data, legacy.verified);
  }
  if (legacy.ok) return R.success(legacy.data, legacy.verified);
  return R.fail(legacy.error || 'Unknown error', legacy.data);
}

/** 新契约 → 旧契约适配器。给尚未迁移的极少数读取点使用。 */
export function toLegacy(r: ConnectorResult): { ok: boolean; verified?: boolean; data?: any; error?: string } {
  if (r.status === 'success') {
    return { ok: true, ...(r.data !== undefined ? { data: r.data } : {}), ...(r.verified !== undefined ? { verified: r.verified } : {}) };
  }
  return { ok: false, error: r.error, verified: false, ...(r.data !== undefined ? { data: r.data } : {}) };
}

/** 健康结果构造器。latencyMs 必须是实测值。 */
export function healthy(latencyMs?: number, endpoint?: string): HealthResult {
  const h: HealthResult = { status: 'healthy' };
  if (typeof latencyMs === 'number') h.latencyMs = latencyMs;
  if (endpoint) h.endpoint = endpoint;
  return h;
}

export function degraded(latencyMs: number | undefined, detail: string, endpoint?: string): HealthResult {
  return { status: 'degraded', latencyMs, detail, ...(endpoint ? { endpoint } : {}) };
}

export function unhealthy(detail: string, endpoint?: string): HealthResult {
  return { status: 'unhealthy', detail, ...(endpoint ? { endpoint } : {}) };
}

export function healthUnknown(detail: string): HealthResult {
  return { status: 'unknown', detail };
}

/** 发现结果构造器：成功时 tools 可以为空，但不允许省略 status。 */
export function discovered(tools: DiscoveredToolRef[], serverInfo?: DiscoveryResult['serverInfo']): DiscoveryResult {
  return { status: 'ok', tools, ...(serverInfo ? { serverInfo } : {}) };
}

export function discoveryFailed(status: Exclude<DiscoveryStatus, 'ok'>, detail: string): DiscoveryResult {
  return { status, tools: [], detail };
}

/** 把旧式健康返回（{ok, error}）转成新契约，丢弃成功分支的伪 error。 */
export function healthFromLegacy(legacy: { ok: boolean; latencyMs?: number; error?: string }): HealthResult {
  if (legacy.ok) {
    // 历史代码在成功分支也写 error，这里统一丢弃，只保留实测延迟。
    return healthy(legacy.latencyMs);
  }
  return unhealthy(legacy.error || 'Health check failed');
}
