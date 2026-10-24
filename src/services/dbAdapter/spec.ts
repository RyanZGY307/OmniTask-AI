// ================================================================
// DB 连接适配层 — 连接规格解析（纯函数，无依赖，可单测）
// ================================================================
// 一个连接可以由三种方式表达，必须全部支持：
//
//   1) 连接字符串（connection string）
//        postgres://user:pass@host:5432/db?sslmode=require
//        postgresql://...
//        file:/abs/path/db.sqlite
//        sqlite:/abs/path/db.sqlite
//        libsql://host/db            ← libSQL/Turso
//
//   2) API 密钥（API key）
//        托管数据库服务（Turso / Neon / Supabase / Layerbase 等）越来越多用
//        token 而不是数据库口令。格式：
//        · api-key:<KEY>             裸密钥，需配合 endpoint
//        · apikey=<KEY>&endpoint=<URL>
//        · Bearer <KEY> + endpoint
//        · libsql://<host>/<db>?authToken=<KEY>
//
//   3) 文件路径（SQLite 本地）
//        ./data/cortex.sqlite
//
//   4) Cloudflare 绑定（binding）—— **不需要 API key，也不需要连接串**
//      Cloudflare 把数据库资源挂到 Worker 的 env 对象上，代码只按名字取：
//        · D1（SQLite）      wrangler.toml [[d1_databases]] binding="CORTEX_D1"
//                           → env.CORTEX_D1（D1Database 实例）
//        · Hyperdrive（PG）  wrangler.toml [[hyperdrive]]    binding="CORTEX_HYPER"
//                           → env.CORTEX_HYPER.connectionString（真正的 PG 连接串
//                             由 Cloudflare 侧持有，代码里不出现）
//      本层只记录「形式 + 绑定名」，**不做 IO**；真正的 env[name] 解析发生在
//      openConnection()（需要 Workers runtime 的 env 对象）。
//
// 本文件只做「解析与判定」，不做 IO，因此可在无任何驱动的环境完整单测。
// ================================================================

export type DbEngine = 'postgres' | 'sqlite' | 'libsql' | 'unknown';
/**
 * Cloudflare 数据库绑定类型。
 * · d1        = D1（Cloudflare 托管 SQLite）
 * · hyperdrive = Hyperdrive（给现有 PG 做连接池，不改变库本身）
 * · generic   = 只写了绑定名、未指明类型（由运行时探测 env[name] 的实际形态）
 */
export type CfBindingKind = 'd1' | 'hyperdrive' | 'generic';

export interface ConnectionSpec {
  // 注意：**不保存 raw**。原始连接串含口令/token，一旦进入返回值就可能被
  // JSON.stringify 后写入日志或观测表。解析只在局部变量里完成。
  engine: DbEngine;
  /** 认证方式：连接串内联 / 独立 API key / 无认证（本地文件） */
  authMode: 'inline' | 'api-key' | 'none' | 'unknown';
  /** endpoint 宿主（用于 routing 与展示，脱敏后） */
  host: string | null;
  /** 数据库名 / 文件路径 */
  target: string;
  /** 从连接串或参数中分离出的 API key（仅用于传给驱动，不落库不打印） */
  apiKey: string | null;
  /** SQLite 文件绝对/相对路径 */
  filePath: string | null;
  /** PostgreSQL 连接参数 */
  pg: { database: string; port: number | null; ssl: boolean } | null;
  /**
   * Cloudflare 绑定信息（仅当输入是绑定形式时非空）。
   * name 是 wrangler.toml 里的 binding 名，不含任何凭据，可安全脱敏展示。
   */
  cfBinding: { kind: CfBindingKind; name: string } | null;
  /** 解析失败原因（用于 admin 页反馈，不含敏感值） */
  error: string | null;
  /**
   * 归一化后的连接串 —— **含凭据，仅用于交给驱动/Prisma**。
   * 绝不写入日志、观测表、错误信息或任何可序列化出口；
   * 需要展示/落库时必须用 redactSpec()。
   */
  normalized: string;
}

/**
 * 日志/观测安全投影：**绝不包含口令或 token**。
 * 所有把规格写进日志、ObsEvent.detail、admin 页展示的地方必须用它。
 */
export function redactSpec(spec: ConnectionSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    engine: spec.engine, authMode: spec.authMode, host: spec.host,
    target: spec.target, error: spec.error,
  };
  if (spec.engine === 'sqlite') out.filePath = spec.filePath;
  if (spec.engine === 'postgres' && spec.pg) {
    out.database = spec.pg.database; out.port = spec.pg.port; out.ssl = spec.pg.ssl;
  }
  // 绑定名不含凭据，可安全投影（Admin 页要显示「这个库来自哪个绑定」）
  if (spec.cfBinding) out.cfBinding = { kind: spec.cfBinding.kind, name: spec.cfBinding.name };
  // apiKey / normalized 一律不出现在投影里
  return out;
}

const PG_PROTOCOLS = /^postgres(?:ql)?:\/\//i;
const SQLITE_PROTOCOLS = /^sqlite(?::|\+file:|:\/\/)/i;
const FILE_PROTOCOLS = /^file:\/\//i;
const LIBSQL_PROTOCOLS = /^libsql:\/\//i;
const APIKEY_PREFIX = /^api[-_]?key:/i;
// Cloudflare 绑定形式。先按「前缀形式」识别，再校验「绑定名」。
const CF_BINDING_FORM =
  /^(?:cf[-_]?binding|cloudflare[-_]?binding|binding|bind)[:=]/i;
const CF_D1_FORM = /^(?:cf[-_]?)?d1[:=]/i;
const CF_HYPER_FORM = /^(?:cf[-_]?)?hyper(?:drive)?[:=]/i;

/** 绑定名合法性：Cloudflare binding 名是 JS 标识符，不允许引号/斜杠/空格。 */
function validBindingName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);   // 形如 CORTEX_D1 / CORTEX_HYPER
}

/** 从 URL 中安全提取 host，绝不包含 userinfo。 */
function safeHost(u: string): string | null {
  try {
    const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    if (!m) return null;
    // 只取 host:port，丢掉 user:pass@
    const hp = m[1].split('@').pop() ?? m[1];
    return hp.split(':')[0] || null;
  } catch { return null; }
}

/** 从 query string 取参数（大小写不敏感）。 */
function qs(url: string, key: string): string | null {
  const qi = url.indexOf('?');
  if (qi < 0) return null;
  for (const part of url.slice(qi + 1).split('&')) {
    const [k, v] = part.split('=');
    if (k && k.toLowerCase() === key.toLowerCase() && v !== undefined) {
      return decodeURIComponent(v.replace(/\+/g, ' '));
    }
  }
  return null;
}

/**
 * 解析一个连接配置。**绝不抛异常** —— 解析失败以 error 字段返回，
 * 由调用方反馈给 admin 页（含原因，不含敏感值）。
 */
export function parseConnection(input: unknown, depth = 0): ConnectionSpec {
  const base: ConnectionSpec = {
    engine: 'unknown', authMode: 'unknown', host: null, target: '',
    apiKey: null, filePath: null, pg: null, cfBinding: null, error: null, normalized: '',
  };
  if (depth > 2) return { ...base, error: 'endpoint 嵌套过深（疑似循环引用）' };
  if (typeof input !== 'string' || !input.trim()) {
    return { ...base, error: '连接配置为空或不是字符串' };
  }
  const raw = input.trim();   // 仅局部变量，不写入输出
  const out: ConnectionSpec = { ...base };

  // ---- 形式 1：裸 API key（需另给 endpoint） ----
  //   "api-key:sk_live_xxx" 或 "apikey=xxx"
  // 先按「形式」识别（前缀），再校验「值」。
  // 否则空值 api-key 会被误判成无法识别的格式，admin 页收到误导性错误。
  const apiKeyForm = /^api[-_]?key[:=]/i.test(raw) || /(^|[?&\s])api[-_]?key=/i.test(raw);
  const bareKey = raw.match(/^api[-_]?key[:=]\s*(.*)$/i)?.[1]?.trim();
  const kvKey = raw.match(/(?:^|[?&\s])api[-_]?key=([^&]*)/i)?.[1]?.trim();
  if (apiKeyForm) {
    const key = (bareKey ?? kvKey ?? '').split('&')[0].trim();
    if (!key) return { ...out, engine: 'unknown', authMode: 'api-key', error: 'API key 为空' };
    // endpoint 可能写成 query 形式（?endpoint=）也可能写成 & 分隔形式
    const endpoint = bareKey
      ? (qs(raw, 'endpoint') ?? raw.match(/[?&]endpoint=([^&]+)/i)?.[1]?.trim() ?? null)
      : null;
    if (!key) return { ...out, error: 'API key 为空' };
    if (!endpoint) {
      return {
        ...out, engine: 'unknown', authMode: 'api-key', apiKey: key,
        error: '缺少 endpoint：裸 API key 必须配合 endpoint 才能确定引擎',
      };
    }
    // endpoint 本身是合法连接串 → 递归解析出引擎（深度保护防环）
    const ep = parseConnection(endpoint, 1);
    if (ep.error && ep.engine === 'unknown') {
      return { ...out, engine: 'unknown', authMode: 'api-key', apiKey: key,
        host: safeHost(endpoint), error: `endpoint 无法识别：${ep.error}` };
    }
    return {
      ...out, engine: ep.engine, authMode: 'api-key', apiKey: key,
      host: ep.host ?? safeHost(endpoint), target: ep.target,
      filePath: ep.filePath, pg: ep.pg,
      normalized: ep.normalized || endpoint,
      error: null,
    };
  }

  // ---- 形式 2：SQLite 文件路径 ----
  if (SQLITE_PROTOCOLS.test(raw) || FILE_PROTOCOLS.test(raw) || /^file:/i.test(raw)) {
    // 同时接受 file://path 与 file:/path（单冒号，SQLAlchemy/Python 习惯）
    const path = raw
      .replace(/^sqlite(\+file)?:\/\//i, '')
      .replace(/^sqlite:/i, '')
      .replace(/^file:\/\//i, '')
      .replace(/^file:/i, '')
      .split('?')[0];
    if (!path) return { ...out, engine: 'sqlite', authMode: 'none', error: 'SQLite 文件路径为空' };
    const mem = path === ':memory:' || path === '' || path.startsWith('file::memory:');
    return {
      ...out, engine: 'sqlite', authMode: 'none', filePath: mem ? ':memory:' : path,
      target: mem ? ':memory:' : path, normalized: mem ? ':memory:' : `file:${path}`,
      host: null, pg: null,
    };
  }

  // ---- 形式 3：PostgreSQL 连接串 ----
  if (PG_PROTOCOLS.test(raw)) {
    if (/\/\/([^@/]*:[^@/]*)@/.test(raw)) {
      // 含 userinfo → authMode: inline（Prisma 自行消费，本层不解析口令）
    }
    const db = (raw.match(/\/\/(?:[^@/]*@)?[^/]+\/([^?]*)/)?.[1] ?? '').trim();
    const portM = raw.match(/\/\/(?:[^@/]*@)?[^/]+:(\d+)/)?.[1];
    const ssl = /sslmode=(require|verify-ca|verify-full)/i.test(raw) || /[\?&]ssl=true/i.test(raw);
    if (!db) return { ...out, engine: 'postgres', authMode: 'inline', error: 'PostgreSQL 连接串缺少数据库名' };
    return {
      ...out, engine: 'postgres', authMode: 'inline', host: safeHost(raw),
      target: db, pg: { database: db, port: portM ? parseInt(portM, 10) : null, ssl },
      normalized: raw,
    };
  }

  // ---- 形式 4：libSQL（Turso）连接串，authToken 即 API key ----
  if (LIBSQL_PROTOCOLS.test(raw)) {
    const token = qs(raw, 'authToken') ?? qs(raw, 'auth_token') ?? qs(raw, 'token');
    const db = (raw.match(/^libsql:\/\/[^/]+\/([^?]*)/)?.[1] ?? '').trim();
    if (!token && raw.includes('authToken')) {
      return { ...out, engine: 'libsql', authMode: 'api-key', error: 'authToken 参数为空' };
    }
    return {
      ...out, engine: 'libsql', authMode: token ? 'api-key' : 'none',
      apiKey: token ?? null, host: safeHost(raw), target: db || '(default)',
      filePath: null, pg: null, normalized: raw,
    };
  }

  // ---- 形式 5：http(s) 端点 + Bearer/API key（托管 KV/SQL over HTTP） ----
  if (/^https?:\/\//i.test(raw)) {
    const token = qs(raw, 'apiKey') ?? qs(raw, 'api_key') ?? qs(raw, 'token') ?? qs(raw, 'auth');
    return {
      ...out, engine: 'unknown', authMode: token ? 'api-key' : 'unknown',
      apiKey: token ?? null, host: safeHost(raw), target: raw.split('?')[0],
      error: token ? null : 'HTTP 端点未提供 API key（apiKey/token 参数）',
    };
  }

  // ---- 形式 6：看起来像本机相对/绝对路径 → 按 SQLite 文件处理 ----
  if (raw === ':memory:' || raw.startsWith('file::memory:')) {
    return {
      ...out, engine: 'sqlite', authMode: 'none', filePath: ':memory:',
      target: ':memory:', normalized: ':memory:', host: null, pg: null,
    };
  }
  if (/^[./~]/.test(raw) || /\.(sqlite|db|sqlite3)$/i.test(raw)) {
    return {
      ...out, engine: 'sqlite', authMode: 'none', filePath: raw,
      target: raw, normalized: `file:${raw}`, host: null, pg: null,
    };
  }

  // ---- 形式 7：Cloudflare 绑定（无 key、无连接串） ----
  // 形态识别必须放在**最后**：否则像 "d1:xxx" 这种会被前面的
  // SQLITE_PROTOCOLS 或路径规则抢先匹配成 SQLite 文件。
  if (CF_D1_FORM.test(raw) || CF_HYPER_FORM.test(raw) || CF_BINDING_FORM.test(raw)) {
    const kind: CfBindingKind = CF_D1_FORM.test(raw)
      ? 'd1'
      : CF_HYPER_FORM.test(raw) ? 'hyperdrive' : 'generic';
    const m = raw.match(/^(?:cf[-_]?binding|cloudflare[-_]?binding|binding|bind|(?:cf[-_]?)?d1|(?:cf[-_]?)?hyper(?:drive)?)\s*[:=]\s*(.*)$/i);
    const name = (m?.[1] ?? '').trim().split(/[?&\s]/)[0].trim();
    if (!name) {
      return { ...out, engine: 'unknown', authMode: 'none', cfBinding: { kind, name: '' },
        error: `Cloudflare ${kind} 绑定名为空（形如 ${kind === 'd1' ? 'd1:CORTEX_D1' : 'hyperdrive:CORTEX_HYPER'}）` };
    }
    if (!validBindingName(name)) {
      return { ...out, engine: 'unknown', authMode: 'none', cfBinding: { kind, name },
        error: `绑定名不是合法标识符：${name}（Cloudflare binding 名只能是字母/数字/_/$，且不以数字开头）` };
    }
    // 引擎归属：D1 的引擎是 sqlite；Hyperdrive 的引擎是 postgres。
    // generic 暂时未知，由运行时探测 env[name] 后确定。
    const engine: DbEngine = kind === 'd1' ? 'sqlite' : kind === 'hyperdrive' ? 'postgres' : 'unknown';
    return {
      ...out, engine, authMode: 'none', cfBinding: { kind, name },
      host: kind === 'hyperdrive' ? 'cloudflare-hyperdrive' : null,
      target: name, normalized: raw,
      error: null,
    };
  }

  return { ...out, error: '无法识别的连接格式：支持 postgres://, sqlite:/file:, libsql://, api-key:+endpoint, cloudflare 绑定（d1:/hyperdrive:/binding:），或文件路径' };
}

/** 判断是否需要 API key 认证（用于 admin 页分区与后续最小权限启用）。 */
export function requiresApiKey(spec: ConnectionSpec): boolean {
  return spec.authMode === 'api-key' && !spec.apiKey;
}

/**
 * 脱敏后的可展示描述：**绝不包含口令、token、文件绝对路径里的敏感段**。
 */
export function describeSpec(spec: ConnectionSpec): string {
  // 绑定形式必须**优先**判断：D1 的 engine 也是 sqlite、Hyperdrive 的 engine
  // 也是 postgres，若按 engine 分支会分别被描述成「SQLite 本地文件」和
  // 「PostgreSQL @ cloudflare-hyperdrive」—— 那是错的，会把「来自 Cloudflare
  // 绑定」这件事藏起来，admin 页无法区分。
  if (spec.cfBinding) {
    const { kind, name } = spec.cfBinding;
    if (kind === 'd1') return `Cloudflare D1 绑定（${name}，SQLite）`;
    if (kind === 'hyperdrive') return `Cloudflare Hyperdrive 绑定（${name} → PostgreSQL）`;
    return `Cloudflare 绑定（${name}，类型待运行时探测）`;
  }
  if (spec.engine === 'sqlite') return `SQLite 文件（${spec.filePath === ':memory:' ? '内存' : '本地文件'}）`;
  if (spec.engine === 'postgres') return `PostgreSQL /${spec.pg?.database ?? '?'} @ ${spec.host ?? '?'}${spec.pg?.ssl ? ' (ssl)' : ''}`;
  if (spec.engine === 'libsql') return `libSQL @ ${spec.host ?? '?'}/auth=api-key`;
  return `HTTP 端点 @ ${spec.host ?? '?'}`;
}

// ==================== 数据频率分级 → 引擎选择 ====================
// SQLite 并发写入性能弱于 PostgreSQL，因此低频写入的数据放 SQLite，
// 高频/一致性要求高的数据留 PostgreSQL。这是**已确定的产品规则**。

export type AccessFrequency = 'high' | 'medium' | 'low';

export interface DomainPlacement {
  domain: string;
  frequency: AccessFrequency;
  reason: string;
}

export const DOMAIN_PLACEMENT: DomainPlacement[] = [
  {
    domain: 'user', frequency: 'high',
    reason: '用户/会话/积分：每请求都读，且涉及资金写入，必须 PostgreSQL',
  },
  {
    domain: 'conversation', frequency: 'high',
    reason: '对话与消息：每次聊天都写，且是已确认写入，必须 PostgreSQL',
  },
  {
    domain: 'knowledge', frequency: 'medium',
    reason: '知识库：读多写少，但存在跨库一致性与并发整理任务，暂留 PostgreSQL',
  },
  {
    domain: 'overflow', frequency: 'low',
    reason: '溢出容错表：仅在主库故障时写入，读取靠对账任务，适合 SQLite',
  },
  {
    domain: 'observability', frequency: 'low',
    reason: '观测指标/事件/摘要清理日志：后台定时写、管理页低频读，适合 SQLite',
  },
];

/** 按频率决定引擎。高频强制 PostgreSQL，不得降级到 SQLite。 */
export function engineForFrequency(f: AccessFrequency): DbEngine {
  return f === 'high' ? 'postgres' : 'sqlite';
}

export function placementFor(domain: string): DomainPlacement | null {
  return DOMAIN_PLACEMENT.find((d) => d.domain === domain) ?? null;
}
