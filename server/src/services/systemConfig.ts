// ================================================================
// System Config — 部署期配置的本地加密存储（替代环境变量）
// ================================================================
// 存放「不应硬编码、也不应由部署平台环境变量提供」的部署期配置：
//   1. 四个 PostgreSQL 连接串（user / conversation / knowledge / overflow）
//   2. 供应商 Base URL 与模型调用的对外端点（原由 PROVIDER_BASE_URL、
//      AGNES_BASE_URL、MIMO_BASE_URL 等环境变量提供）
//   3. 检索/媒体类外部服务密钥的搬运登记（值本身不入本文件，由 vault 管）
//
// 为什么不再读环境变量：
//   部署平台的环境变量对租户不可见、不可改、不可审计；一旦要换库或换
//   供应商端点，就得重新部署。改由后端 API 管理页面维护后，运维动作
//   变成一次带权限、带审计的 HTTP 调用。
//
// 引导问题（本模块存在的真正原因）：
//   连接串若只存在数据库里，就先得连上那个数据库——鸡生蛋。因此采用
//   「本地加密文件 + 首次配置模式」：
//     · 文件不存在 → isSetupRequired() 为真，服务只开放 /api/system/*，
//       其余一律 503 setupRequired，绝不静默用一个默认连接串启动。
//     · 文件存在   → 正常模式，所有连接串从文件解密读出。
//   文件用 vault 的 AES-256-GCM 加密；密钥来自 data/system-config.key
//   （首次运行自动生成本地随机密钥），VAULT_KEY 只作兼容回退。
//
// 设计约束（对应任务书"不得伪造"）：
//   · validateConnectionUrl 只做语法与协议校验，**不当作可达性证明**；
//     真实连通性由 setup 端点显式 connect 验证，未通过就不落盘。
//   · 本机无法执行 Prisma 引擎（x86_64 vs arm64），故 CONNECT_VERIFY
//     的真实握手路径未经实测；逻辑与降级路径有测试覆盖，握手本身没有。
// ================================================================

import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

// ⚠️ 不能在本模块顶层 import vault：vault.ts 顶层 import db.ts，
// 而 db.ts 又要在模块顶层同步调用本模块的 loadSystemConfigSync() 来取
// 连接串。顶层 import 会形成
//   systemConfig → vault → db → systemConfig
// 环，导致 systemConfig 的模块体尚未执行完就被 db 调用，`loaded` 仍在
// TDZ，"Cannot access 'loaded' before initialization" 使进程起不来。
// 因此 vault 全部改为函数内惰性 require —— 调用发生在 db.ts 构造完
// PrismaClient 之后，环已自然断开。
type VaultMod = typeof import('../connections/vault');
let _vault: VaultMod | null = null;
function vault(): VaultMod {
  if (!_vault) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _vault = require('../connections/vault') as VaultMod;
    _vault.initVault();
  }
  return _vault;
}

// ---- 加密依赖注入 ----
// 生产路径必须走 vault（AES-256-GCM，与凭证存储同一把密钥体系）。
// 但 require(vault) 会连带加载 db.ts 并构造 4 个 PrismaClient；在无法
// 运行 Prisma 引擎的环境里，这会拖死纯配置逻辑的测试。因此留一个显式
// 注入缝。这不是测试专用后门——想替换密钥来源的部署同样可以用它。
export interface CipherPair {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}
let _cipher: CipherPair | null = null;
function cipher(): CipherPair {
  if (_cipher) return _cipher;
  const v = vault();
  return {
    encrypt: (p: string) => v.encryptSecret(p),
    decrypt: (c: string) => v.decryptSecret(c),
  };
}
/** 覆盖加解密实现；传 null 恢复为 vault。 */
export function __setCipherForTests(c: CipherPair | null): void {
  _cipher = c;
}

// ---- 文件位置：沿用 media 的约定（固定相对路径，可被显式覆盖） ----
function dataDir(): string {
  return path.join(process.cwd(), 'data');
}
export function systemConfigPath(): string {
  return path.join(dataDir(), 'system-config.json');
}
function keyFilePath(): string {
  return path.join(dataDir(), 'system-config.key');
}

// ---- 四个数据域的固定标识 ----
export const DB_DOMAINS = ['user', 'conversation', 'knowledge', 'overflow'] as const;
export type DbDomain = typeof DB_DOMAINS[number];

export interface DbConnection {
  domain: DbDomain;
  url: string;
  label?: string;
  updatedAt: string;
}

export interface ProviderEndpoint {
  provider: string;      // 供应商名（admin 页自填，不写死在代码里）
  tier: 'FREE' | 'PRO';
  baseUrl: string;       // 完整端点，调用时原样 POST
  updatedAt: string;
}

export interface SystemConfigFile {
  version: number;
  dbConnections: DbConnection[];
  providerEndpoints: ProviderEndpoint[];
  createdAt: string;
  updatedAt: string;
}

// ---- 连接串语法校验（不验证可达性） ----
// ⚠️ 不用 `{ ok: true } | { ok: false; reason }` 这种布尔字面量判别联合：
// 本项目 tsconfig 是 strict:false / strictNullChecks:false，在该配置下
// TS 不会把 `if (!c.ok)` 的分支窄化成 { ok:false }，取 c.reason 直接
// 报 TS2339。用「单接口 + 可选 reason」在任何 strict 配置下都成立。
export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

export function validateConnectionUrl(raw: unknown): UrlCheck {
  if (typeof raw !== 'string') return { ok: false, reason: '连接串必须是字符串' };
  const s = raw.trim();
  if (!s) return { ok: false, reason: '连接串不能为空' };
  if (/\s/.test(s)) return { ok: false, reason: '连接串不能含空白字符' };
  if (!/^postgres(ql)?:\/\//i.test(s)) {
    return { ok: false, reason: '必须是 postgres:// 或 postgresql:// 协议' };
  }
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, reason: 'URL 格式无法解析' }; }
  if (!u.hostname) return { ok: false, reason: '缺少主机名' };
  if (!u.username) return { ok: false, reason: '缺少用户名' };
  if (!u.password) return { ok: false, reason: '缺少密码' };
  if (!u.pathname || u.pathname === '/') return { ok: false, reason: '缺少数据库名' };
  if (u.port && !/^\d+$/.test(u.port)) return { ok: false, reason: '端口必须为数字' };
  if (u.port && Number(u.port) > 65535) return { ok: false, reason: '端口超出范围' };
  // 多语句/控制字符注入防护：连接串只走 libpq 参数字符串，不允许分号拼接
  if (/[;\r\n]/.test(s)) return { ok: false, reason: '连接串含非法控制字符' };
  return { ok: true };
}

// ---- 密钥管理：本地生成优先，VAULT_KEY 仅作兼容回退 ----
async function ensureKey(): Promise<string> {
  const kp = keyFilePath();
  try {
    const existing = (await fs.readFile(kp, 'utf-8')).trim();
    if (existing) return existing;
  } catch { /* 不存在则创建 */ }

  // VAULT_KEY 存在时复用它，保证同一把密钥也能解开已存凭证
  const inherited = process.env.VAULT_KEY?.trim();
  if (inherited) {
    await fs.mkdir(dataDir(), { recursive: true });
    await fs.writeFile(kp, inherited, { mode: 0o600 });
    return inherited;
  }

  const generated = randomBytes(32).toString('hex');
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(kp, generated, { mode: 0o600 });
  return generated;
}

// ---- 序列化 / 反序列化 ----
export function serializeConfig(cfg: SystemConfigFile): string {
  return JSON.stringify({
    version: cfg.version,
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt,
    // 只加密连接串与端点，明文部分仅结构信息
    dbConnections: cfg.dbConnections.map((c) => ({
      domain: c.domain, label: c.label || '', updatedAt: c.updatedAt,
      enc: cipher().encrypt(c.url),
    })),
    providerEndpoints: cfg.providerEndpoints.map((p) => ({
      provider: p.provider, tier: p.tier, updatedAt: p.updatedAt,
      enc: cipher().encrypt(p.baseUrl),
    })),
  }, null, 2);
}

export function deserializeConfig(raw: string): SystemConfigFile {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('系统配置文件损坏：不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('系统配置文件损坏：结构不是对象');
  if (!Array.isArray(parsed.dbConnections)) parsed.dbConnections = [];
  if (!Array.isArray(parsed.providerEndpoints)) parsed.providerEndpoints = [];

  const dbConnections: DbConnection[] = [];
  for (const row of parsed.dbConnections) {
    if (!row || !DB_DOMAINS.includes(row.domain)) continue;
    let url = '';
    try { url = cipher().decrypt(String(row.enc)); } catch (e: any) {
      throw new Error(`系统配置解密失败（${row.domain}）：${e?.message || '密钥不匹配'}`);
    }
    dbConnections.push({ domain: row.domain, url, label: row.label || '', updatedAt: row.updatedAt || '' });
  }

  const providerEndpoints: ProviderEndpoint[] = [];
  for (const row of parsed.providerEndpoints) {
    if (!row || typeof row.provider !== 'string') continue;
    let baseUrl = '';
    try { baseUrl = cipher().decrypt(String(row.enc)); } catch { continue; }
    providerEndpoints.push({
      provider: row.provider, tier: row.tier === 'PRO' ? 'PRO' : 'FREE',
      baseUrl, updatedAt: row.updatedAt || '',
    });
  }

  return {
    version: Number(parsed.version) || 1,
    dbConnections, providerEndpoints,
    createdAt: parsed.createdAt || '', updatedAt: parsed.updatedAt || '',
  };
}

// ---- 进程内缓存 ----
let cached: SystemConfigFile | null = null;
let loaded = false;

export function isSetupRequired(): boolean {
  return !loaded || cached === null || cached!.dbConnections.length === 0;
}

export function getSystemConfig(): SystemConfigFile | null {
  return cached;
}

/** 供 setup 端点写入后调用：热加载新连接串，不需要重启进程。 */
export async function reloadSystemConfig(): Promise<SystemConfigFile> {
  loaded = false;
  cached = null;
  await loadSystemConfig();
  return cached!;
}

export async function loadSystemConfig(): Promise<SystemConfigFile | null> {
  if (loaded) return cached;
  try {
    const raw = await fs.readFile(systemConfigPath(), 'utf-8');
    const cfg = deserializeConfig(raw);
    cached = cfg;
    loaded = true;
    return cfg;
  } catch (e: any) {
    // ENOENT = 首次启动，进入配置模式；其余错误必须上抛，不能静默
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      loaded = true;          // 已尝试过，避免每次请求重复读盘
      cached = null;
      return null;
    }
    console.error('[SystemConfig] 读取失败（拒绝启动而非使用默认值）:', e?.message || e);
    throw e;
  }
}

/**
 * 同步加载。db.ts 在模块顶层构造 PrismaClient，必须在**同一同步 tick**内
 * 拿到连接串；异步 load 必然晚于构造，导致拿到 placeholder。
 *
 * 两种失败必须区别对待（此前此处一并降级为 null，那是错的）：
 *   · 文件不存在（ENOENT）→ 首次运行，返回 null，进入 setup 模式。
 *   · 文件存在但读不了 / JSON 坏 / 密钥不匹配 → **抛错让进程起不来**。
 *     这类情况说明配置曾经存在却坏了、换了密钥、或被改过。把它当成
 *     "还没配置"会让服务顶着 placeholder 对外返回 503 setupRequired，
 *     操作者以为重填一次即可，于是覆盖掉现场、丢失排查线索——这是任务书
 *     禁止的静默降级。宁可起不来，也要让问题当场暴露。
 */
export function loadSystemConfigSync(): SystemConfigFile | null {
  if (loaded) return cached;
  try {
    const raw = require('fs').readFileSync(systemConfigPath(), 'utf-8');
    const cfg = deserializeConfig(raw);
    cached = cfg;
    loaded = true;
    return cfg;
  } catch (e: any) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      loaded = true;
      cached = null;
      return null;
    }
    throw new Error(
      `[SystemConfig] 配置文件存在但无法使用（${systemConfigPath()}）：${e?.message || e}\n` +
      `  这不是"尚未配置"。可能原因：密钥不匹配、文件被截断、手工编辑损坏。\n` +
      `  确认不再需要其中内容后，删除该文件并重新走首次配置；否则先备份再排查密钥。`,
    );
  }
}

// ---- 写入：仅由 setup/管理端点调用，需先通过连通性验证 ----
export async function writeDbConnection(d: {
  domain: DbDomain;
  url: string;
  label?: string;
}): Promise<void> {
  await ensureKey();
  const cfg = (await loadSystemConfig()) || {
    version: 1, dbConnections: [], providerEndpoints: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const now = new Date().toISOString();
  const next: DbConnection = { domain: d.domain, url: d.url, label: d.label || '', updatedAt: now };
  const filtered = cfg.dbConnections.filter((c) => c.domain !== d.domain);
  filtered.push(next);
  const out: SystemConfigFile = {
    ...cfg, dbConnections: filtered, updatedAt: now,
  };
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(systemConfigPath(), serializeConfig(out), { mode: 0o600 });
  cached = out;
}

export function getDbConnection(domain: DbDomain): string | null {
  if (!cached) return null;
  const row = cached.dbConnections.find((c) => c.domain === domain);
  return row ? row.url : null;
}

/** 掩码展示：不向前端回传可用连接串。 */
export function maskedDbConnections(): Array<{
  domain: string; label: string; updatedAt: string; ok: boolean; masked: string;
}> {
  if (!cached) return [];
  return cached.dbConnections.map((c) => ({
    domain: c.domain, label: c.label || '', updatedAt: c.updatedAt,
    ok: true, masked: maskUrl(c.url),
  }));
}

export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const user = u.username ? `${u.username}:***@` : '';
    const db = u.pathname ? u.pathname : '';
    return `${u.protocol}//${user}${u.hostname}${u.port ? ':' + u.port : ''}${db}`;
  } catch {
    return '<invalid>';
  }
}

/** 供测试：清空进程缓存。 */
export function __resetSystemConfigCache(): void { loaded = false; cached = null; }
