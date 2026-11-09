"use client";
import { useCallback, useEffect, useState } from 'react';
import ConnectionGate from '../../../components/ConnectionGate';
import { Field, RateLimitEditor, type RateLimitBlock } from '../../../components/RateLimitEditor';

type AssetRow = { assetKey: string; assetType: string; status: string; currentVersion: number };
type ChangeRow = { id: string; assetKey: string; fromVersion: number; toVersion: number; riskLevel: string; status: string; proposedBy: string; gateLevel: number };
type PauseRow = { id: string; scope: string; resource: string; level: string; reason: string; expiresAt?: string | null; resumedAt?: string | null };
type JobRow = { id: string; kind: string; status: string; attemptCount: number; lastError?: string | null };
type RsiProviderRow = {
  provider: string; tier: 'FREE' | 'PRO'; baseUrl?: string | null;
  apiKeys?: string[]; apiLimit?: unknown; carrierLimit?: unknown; rsiModelLimit?: unknown;
  enabled: boolean;
};
type SwitchRow = { id: string; level: string; quotaType: string; fromApi: string; toApi: string; fromModel?: string | null; toModel?: string | null; reason?: string | null; createdAt: string };

const RISK_TONE: Record<string, string> = { r0: 'text-emerald-300', r1: 'text-emerald-300', r2: 'text-amber-300', r3: 'text-rose-300' };
const STATUS_TONE: Record<string, string> = {
  pending: 'text-amber-300', awaiting_approval: 'text-amber-300', evaluating: 'text-sky-300', canary: 'text-sky-300',
  released: 'text-emerald-300', rejected: 'text-muted', failed: 'text-rose-300', rolled_back: 'text-rose-300', approved: 'text-emerald-300',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  const res = await fetch((process.env.NEXT_PUBLIC_API_URL || '/api') + path, {
    ...init, cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** 受控 RSI 控制台。只读展示 + 人工动作（批准/拒绝/放量/回滚/暂停/恢复）。 */
export default function RsiAdminPage() {
  const [tab, setTab] = useState<'overview' | 'changes' | 'assets' | 'pause' | 'jobs' | 'providers'>('overview');
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [changes, setChanges] = useState<ChangeRow[]>([]);
  const [pauses, setPauses] = useState<PauseRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [providers, setProviders] = useState<RsiProviderRow[]>([]);
  const [switchLogs, setSwitchLogs] = useState<SwitchRow[]>([]);
  const [quota, setQuota] = useState<any>(null);
  const [pf, setPf] = useState({ provider: '', tier: 'FREE', baseUrl: '', modelKey: '', apiKeys: '' });
  const [pfLimit, setPfLimit] = useState<RateLimitBlock>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, c, p, j, v] = await Promise.all([
        api<{ assets: AssetRow[] }>('/rsi/assets?limit=200').catch(() => ({ assets: [] })),
        api<{ changes: ChangeRow[] }>('/rsi/changes?limit=100').catch(() => ({ changes: [] })),
        api<{ pauses: PauseRow[] }>('/rsi/pauses').catch(() => ({ pauses: [] as PauseRow[] })),
        api<{ jobs: JobRow[] }>('/rsi/jobs?limit=50').catch(() => ({ jobs: [] as JobRow[] })),
        api<{ providers: RsiProviderRow[] }>('/rsi/provider-configs').catch(() => ({ providers: [] })),
        api<{ logs: SwitchRow[] }>('/rsi/quota/switch-logs?limit=50').catch(() => ({ logs: [] })),
      ]);
      setAssets(a.assets || []); setChanges(c.changes || []); setPauses(p.pauses || []);
      setJobs(j.jobs || []); setProviders(v.providers || []);
      setSwitchLogs(l.logs || []);
      setMsg(null);
    } catch (e) { setMsg((e as Error).message); }
  }, []);

  const saveProvider = async () => {
    setBusy(true); setMsg(null);
    try {
      const keys = pf.apiKeys.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      if (!pf.provider || keys.length === 0) { setMsg('provider 与至少一个 API Key 必填'); setBusy(false); return; }
      await api('/rsi/provider-configs', {
        method: 'POST',
        body: JSON.stringify({
          provider: pf.provider, tier: pf.tier, baseUrl: pf.baseUrl || undefined,
          apiKeys: keys,
          apiLimit: pfLimit, carrierLimit: pfLimit, rsiModelLimit: pfLimit,
          modelKey: pf.modelKey || undefined,
        }),
      });
      setMsg('已保存 RSI Provider（密钥只写后端，列表不回显明文）');
      await load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const disableProvider = async (provider: string, tier: string) => {
    setBusy(true); setMsg(null);
    try {
      await api('/rsi/provider-configs/disable', { method: 'POST', body: JSON.stringify({ provider, tier }) });
      setMsg('已停用（软删，历史额度与切换记录保留）');
      await load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const checkQuota = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>('/rsi/quota/check', {
        method: 'POST',
        body: JSON.stringify({
          provider: pf.provider, tier: pf.tier, modelKey: pf.modelKey,
          estimatedTokens: 1000, apiLimit: pfLimit, carrierLimit: pfLimit, rsiModelLimit: pfLimit,
        }),
      });
      setQuota(r);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  useEffect(() => { load(); }, [load]);

  const act = async (path: string, body: unknown, okText: string) => {
    setBusy(true); setMsg(null);
    try { await api(path, { method: 'POST', body: JSON.stringify(body) }); await load(); setMsg(okText); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const TABS: Array<[typeof tab, string]> = [
    ['overview', '总览'], ['changes', '变更单'], ['assets', '资产'], ['pause', '暂停'], ['jobs', '队列'], ['providers', 'RSI 额度'],
  ];
  const card = 'border border-border/60 rounded-card p-3';
  const inp = 'bg-bg border border-border rounded-card px-2 py-1.5 text-xs font-mono';

  return (
    <ConnectionGate>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-primary">受控 RSI 控制台</h1>
          <button onClick={load} className="px-3 py-1.5 text-xs rounded-card border border-border text-muted hover:text-primary">刷新</button>
        </div>

        <div className="flex gap-1 flex-wrap">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-2.5 py-1 text-[11px] rounded-capsule border ${tab === k ? 'border-accent text-accent' : 'border-border text-muted'}`}>
              {label}
            </button>
          ))}
        </div>

        {msg && <div className="text-xs font-mono text-amber-300 break-all">{msg}</div>}

        {tab === 'overview' && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {([
              ['资产', assets.length], ['变更单', changes.length],
              ['待审批', changes.filter((c) => c.status === 'awaiting_approval').length],
              ['灰度中', changes.filter((c) => c.status === 'canary').length],
              ['已发布', changes.filter((c) => c.status === 'released').length],
              ['已回滚', changes.filter((c) => c.status === 'rolled_back').length],
              ['暂停规则', pauses.filter((p) => !p.resumedAt).length],
              ['待处理队列', jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING').length],
              ['RSI Provider', providers.length],
            ] as Array<[string, number]>).map(([label, value]) => (
              <div key={label} className={card}>
                <div className="text-[10px] text-muted/70">{label}</div>
                <div className="text-xl font-mono text-primary">{value}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'changes' && (
          <div className={`${card} divide-y divide-border/40`}>
            {changes.length === 0 && <div className="p-4 text-xs text-muted">暂无变更单</div>}
            {changes.map((c) => (
              <div key={c.id} className="p-3 flex items-center gap-3 flex-wrap text-xs">
                <span className="font-mono text-primary">{c.assetKey}</span>
                <span className="font-mono text-muted">v{c.fromVersion}→v{c.toVersion}</span>
                <span className={`font-mono ${RISK_TONE[c.riskLevel] || 'text-muted'}`}>{c.riskLevel}</span>
                <span className="font-mono text-muted">gate{c.gateLevel}</span>
                <span className={`font-mono ${STATUS_TONE[c.status] || 'text-muted'}`}>{c.status}</span>
                <span className="font-mono text-muted/60 ml-auto">{c.proposedBy}</span>
                {c.status === 'awaiting_approval' && (<>
                  <button disabled={busy} onClick={() => act(`/rsi/changes/${c.id}/approve`, {}, '已批准')}
                    className="px-2 py-1 rounded-capsule border border-emerald-500/40 text-emerald-300">批准</button>
                  <button disabled={busy} onClick={() => act(`/rsi/changes/${c.id}/reject`, { reason: 'manual' }, '已拒绝')}
                    className="px-2 py-1 rounded-capsule border border-rose-500/40 text-rose-300">拒绝</button>
                </>)}
                {c.status === 'canary' && (<>
                  <button disabled={busy} onClick={() => act(`/rsi/changes/${c.id}/rollout`, { action: 'promote' }, '已放量')}
                    className="px-2 py-1 rounded-capsule border border-emerald-500/40 text-emerald-300">放量</button>
                  <button disabled={busy} onClick={() => act(`/rsi/changes/${c.id}/rollout`, { action: 'rollback' }, '已回滚')}
                    className="px-2 py-1 rounded-capsule border border-rose-500/40 text-rose-300">回滚</button>
                </>)}
              </div>
            ))}
          </div>
        )}

        {tab === 'assets' && (
          <div className={`${card} divide-y divide-border/40`}>
            {assets.length === 0 && <div className="p-4 text-xs text-muted">暂无资产登记</div>}
            {assets.map((a) => (
              <div key={`${a.assetType}:${a.assetKey}`} className="p-3 flex items-center gap-3 text-xs font-mono flex-wrap">
                <span className="text-primary">{a.assetKey}</span>
                <span className="text-muted">{a.assetType}</span>
                <span className="text-muted/60">v{a.currentVersion}</span>
                <span className={`ml-auto ${a.status === 'active' ? 'text-emerald-300' : 'text-amber-300'}`}>{a.status}</span>
              </div>
            ))}
          </div>
        )}

        {tab === 'pause' && (
          <div className="space-y-3">
            <div className={`${card} space-y-2`}>
              <div className="text-xs text-primary">新建暂停（写暂停不阻断进行中的任务，只挡新读取与新写入）</div>
              <PauseForm onSave={(b) => act('/rsi/pause', b, '已暂停')} busy={busy} />
            </div>
            <div className={`${card} divide-y divide-border/40`}>
              {pauses.length === 0 && <div className="p-4 text-xs text-muted">暂无暂停规则</div>}
              {pauses.map((p) => (
                <div key={p.id} className="p-3 flex items-center gap-3 text-xs font-mono flex-wrap">
                  <span className="text-primary">{p.scope}</span>
                  <span className="text-muted">{p.resource || '-'}</span>
                  <span className="text-muted">level={p.level}</span>
                  <span className="text-muted/60 truncate max-w-[35%]">{p.reason || ''}</span>
                  {!p.resumedAt && (
                    <button disabled={busy} onClick={() => act(`/rsi/pauses/${p.id}/resume`, {}, '已恢复')}
                      className="ml-auto px-2 py-1 rounded-capsule border border-border text-muted hover:text-primary">恢复</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'jobs' && (
          <div className={`${card} divide-y divide-border/40`}>
            {jobs.length === 0 && <div className="p-4 text-xs text-muted">队列无任务</div>}
            {jobs.map((j) => (
              <div key={j.id} className="p-3 flex items-center gap-3 text-xs font-mono flex-wrap">
                <span className="text-primary">{j.kind}</span>
                <span className="text-muted">{j.status}</span>
                <span className="text-muted/60">attempt {j.attemptCount}</span>
                {j.lastError && <span className="text-rose-300 truncate max-w-[45%]">{j.lastError}</span>}
              </div>
            ))}
          </div>
        )}

        {tab === 'providers' && (
          <div className="space-y-3">
            <div className={`${card} space-y-2`}>
              <div className="text-xs text-primary">已配置的 RSI Provider（数据与 /admin/models 完全隔离，密钥只写不读）</div>
              {providers.length === 0 && <div className="text-xs text-muted">未配置。RSI 提案所用模型密钥在此独立维护。</div>}
              {providers.map((p) => (
                <div key={`${p.provider}:${p.tier}`} className="flex items-center gap-2 text-xs font-mono flex-wrap">
                  <span className="text-primary">{p.provider}</span>
                  <span className="text-muted">{p.tier}</span>
                  <span className={p.enabled ? 'text-emerald-300' : 'text-rose-300'}>{p.enabled ? 'enabled' : 'disabled'}</span>
                  <span className="text-muted/60">key×{(p.apiKeys ?? []).length}</span>
                  <button disabled={busy} onClick={() => disableProvider(p.provider, p.tier)}
                    className="ml-auto px-2 py-0.5 rounded-capsule border border-rose-500/40 text-rose-300">停用</button>
                </div>
              ))}
            </div>

            <div className={`${card} space-y-2`}>
              <div className="text-xs text-primary">新增 / 更新 RSI Provider 与三级额度</div>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Provider"><input value={pf.provider} onChange={(e) => setPf({ ...pf, provider: e.target.value })} placeholder="agnes" className={`${inp} w-32`} /></Field>
                <Field label="Tier">
                  <select value={pf.tier} onChange={(e) => setPf({ ...pf, tier: e.target.value })} className={`${inp} w-20`}>
                    <option value="FREE">FREE</option><option value="PRO">PRO</option>
                  </select>
                </Field>
                <Field label="BaseUrl"><input value={pf.baseUrl} onChange={(e) => setPf({ ...pf, baseUrl: e.target.value })} placeholder="可空" className={`${inp} w-56`} /></Field>
                <Field label="ModelKey"><input value={pf.modelKey} onChange={(e) => setPf({ ...pf, modelKey: e.target.value })} placeholder="模型级限额用" className={`${inp} w-40`} /></Field>
              </div>
              <Field label="API Key（每行一个；只写后端，列表永不回显明文）">
                <textarea value={pf.apiKeys} onChange={(e) => setPf({ ...pf, apiKeys: e.target.value })} rows={2}
                  className={`${inp} w-full font-mono`} />
              </Field>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div><div className="text-[10px] text-muted/70 mb-0.5">单 API 额度 apiLimit</div>
                  <RateLimitEditor value={pfLimit} onChange={setPfLimit} /></div>
                <div><div className="text-[10px] text-muted/70 mb-0.5">运营商聚合 carrierLimit（同左值演示，实际可分别填）</div>
                  <RateLimitEditor value={pfLimit} onChange={setPfLimit} /></div>
                <div><div className="text-[10px] text-muted/70 mb-0.5">模型级 rsiModelLimit</div>
                  <RateLimitEditor value={pfLimit} onChange={setPfLimit} /></div>
              </div>
              <div className="text-[10px] text-muted/60">填『-』或留空 = 不限制；RPM/TPM/RPD/TPD/最大并发，与普通 API 管理页同一套 RateLimitEditor 口径。</div>
              <div className="flex gap-2">
                <button disabled={busy} onClick={saveProvider} className="px-3 py-1.5 text-xs rounded-card border border-accent/40 text-accent">保存</button>
                <button disabled={busy} onClick={checkQuota} className="px-3 py-1.5 text-xs rounded-card border border-border text-muted">额度预检</button>
              </div>
              {quota && <pre className="text-[10px] font-mono text-muted/70 whitespace-pre-wrap break-all">{JSON.stringify(quota, null, 1)}</pre>}
            </div>

            <div className={`${card} space-y-1`}>
              <div className="text-xs text-primary">RSI 额度自动切换记录（RsiQuotaSwitchLog，独立于普通 QuotaSwitchLog）</div>
              {switchLogs.length === 0 && <div className="text-xs text-muted">暂无切换记录</div>}
              {switchLogs.map((l) => (
                <div key={l.id} className="flex items-center gap-2 text-[11px] font-mono flex-wrap">
                  <span className="text-muted/60">{new Date(l.createdAt).toLocaleString()}</span>
                  <span className="text-primary">{l.level}</span>
                  <span className="text-amber-300">{l.quotaType}</span>
                  <span className="text-muted">{l.fromApi}→{l.toApi}</span>
                  <span className="text-muted/60">{l.reason}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </ConnectionGate>
  );
}

function PauseForm({ onSave, busy }: { onSave: (b: Record<string, unknown>) => void; busy: boolean }) {
  const [scope, setScope] = useState('global');
  const [resource, setResource] = useState('');
  const [level, setLevel] = useState('write');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState('');
  const sel = 'bg-bg border border-border rounded-card px-2 py-1.5 text-xs font-mono';
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="作用域">
        <select value={scope} onChange={(e) => setScope(e.target.value)} className={sel}>
          <option value="global">global</option><option value="asset_type">asset_type</option>
          <option value="asset_key">asset_key</option><option value="worker_kind">worker_kind</option>
        </select>
      </Field>
      <Field label="资源"><input value={resource} onChange={(e) => setResource(e.target.value)} placeholder="worker_kind=rsi 必填"
        className={`${sel} w-40`} /></Field>
      <Field label="级别">
        <select value={level} onChange={(e) => setLevel(e.target.value)} className={sel}>
          <option value="write">write</option><option value="read">read</option><option value="all">all</option>
        </select>
      </Field>
      <Field label="时长(小时，空=永久)"><input value={hours} onChange={(e) => setHours(e.target.value)} className={`${sel} w-24`} /></Field>
      <Field label="原因"><input value={reason} onChange={(e) => setReason(e.target.value)} className={`${sel} w-56`} /></Field>
      <button disabled={busy} onClick={() => onSave({
        scope, resource: resource || undefined, level, reason: reason || undefined,
        expiresAt: hours ? new Date(Date.now() + Number(hours) * 3600_000).toISOString() : undefined,
      })} className="px-3 py-1.5 text-xs rounded-card border border-accent/40 text-accent">保存</button>
    </div>
  );
}
