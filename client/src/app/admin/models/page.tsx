'use client';
// ================================================================
// 模型管理 — 后端模型/密钥/限额的唯一管理入口。
// 免费 / Pro 供应商「完全分离」，各自独立配置：
//   名称 · 完整URL（不再拼接）· API KEY（无数量上限）· 模型 · 积分（Pro）
//   三类速率限制：单API / 运营商 / 调用模型
// 模型可在此添加/删除/改价（改价走 PUT /admin/models/:modelKey，只传价格，
//   不重传其余字段，也不会把误改的字段写成默认值）。
// 用户端对话面板按此列表显示。
// ================================================================

import { useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api';
import { RateLimitEditor, Field } from '../../components/RateLimitEditor';
import type { RateLimitBlock } from '../../components/RateLimitEditor';

type Tier = 'FREE' | 'PRO';

interface Conn {
  provider: string; tier: Tier; label: string; baseUrl: string;
  apiKeys: string[]; apiLimit: Partial<RateLimitBlock>; carrierLimit: Partial<RateLimitBlock>;
  enabled: boolean;
}
interface ModelRow {
  modelKey: string; provider: string; apiModel: string; displayName: string; vendor: string;
  tier: Tier; costPer1k: number; rateLimit?: Partial<RateLimitBlock>;
}

const emptyLimit = (): RateLimitBlock => ({ tpdBehavior: 'block' });

export default function AdminModelsPage() {
  const [tier, setTier] = useState<Tier>('FREE');
  const [connections, setConnections] = useState<Conn[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  // 添加/编辑连接表单
  const [provider, setProvider] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKeys, setApiKeys] = useState<string[]>(['']);
  const [apiLimit, setApiLimit] = useState<RateLimitBlock>(emptyLimit());
  const [carrierLimit, setCarrierLimit] = useState<RateLimitBlock>(emptyLimit());

  // 添加模型表单
  const [modelList, setModelList] = useState<any[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [apiModel, setApiModel] = useState('');
  const [modelTier, setModelTier] = useState<Tier>(tier);
  const [vendor, setVendor] = useState('');
  const [credits1M, setCredits1M] = useState('0');
  const [modelLimit, setModelLimit] = useState<RateLimitBlock>(emptyLimit());
  const [saving, setSaving] = useState(false);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); };
  const inputCls = 'w-full bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50';
  const labelCls = 'block text-[11px] text-muted mb-1.5 font-medium';

  const refresh = async () => {
    try {
      const [cRes, mRes] = await Promise.all([
        apiGet('/admin/provider-connections').catch(() => null),
        apiGet('/admin/models').catch(() => null),
      ]);
      setConnections((cRes?.connections || []).map((c: any) => ({
        provider: c.provider, tier: (c.tier || 'FREE') as Tier, label: c.label || c.provider,
        baseUrl: c.baseUrl, apiKeys: c.apiKeys || [],
        apiLimit: safeObj(c.apiLimit), carrierLimit: safeObj(c.carrierLimit), enabled: c.enabled !== false,
      })));
      const mm = mRes?.models || {};
      setModels(Object.entries(mm).map(([k, m]: [string, any]) => ({
        modelKey: k, provider: m.provider, apiModel: m.apiModel, displayName: m.displayName,
        vendor: m.vendor || '', tier: (m.tier === 'PRO' ? 'PRO' : 'FREE') as Tier,
        costPer1k: m.costPer1k ?? 0, rateLimit: safeObj((m as any).rateLimit),
      })));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);

  const connSave = async () => {
    if (!provider.trim() || !baseUrl.trim()) { flash('请填写名称与完整 URL'); return; }
    try {
      await apiPost('/admin/provider-connections', {
        provider: provider.trim(), tier, label: label.trim() || provider.trim(),
        baseUrl: baseUrl.trim(),
        apiKeys: apiKeys.map((k) => k.trim()).filter(Boolean),
        apiLimit, carrierLimit, enabled: true,
      });
      flash(`${tier === 'FREE' ? '免费' : 'Pro'} 供应商 ${provider} 已保存`);
      setProvider(''); setLabel(''); setBaseUrl(''); setApiKeys(['']);
      setApiLimit(emptyLimit()); setCarrierLimit(emptyLimit());
      refresh();
    } catch (e: any) { flash(`保存失败：${e?.message || ''}`); }
  };

  const delConn = async (p: string, t: Tier) => {
    if (!confirm(`删除供应商 ${p}（${t}）？其密钥与限额将清空`)) return;
    try {
      await apiDelete(`/admin/provider-connections/${encodeURIComponent(p)}?tier=${t}`);
      flash('已删除'); refresh();
    } catch (e: any) { flash(`删除失败：${e?.message || ''}`); }
  };

  const fetchList = async () => {
    if (!baseUrl.trim()) { flash('请先填写完整 URL'); return; }
    setFetching(true); setModelList(null);
    try {
      const firstKey = apiKeys.find((k) => k.trim()) || undefined;
      const d = await apiPost('/admin/models/fetch-list', { baseUrl: baseUrl.trim(), apiKey: firstKey });
      setModelList(d.models || []);
      if (!(d.models || []).length) flash('拉取成功，但该服务未返回模型清单');
    } catch (e: any) { flash(`拉取列表失败：${e?.message || '网络错误'}`); }
    finally { setFetching(false); }
  };

  const saveModel = async () => {
    if (!apiModel.trim()) { flash('请填写模型名称'); return; }
    setSaving(true);
    try {
      // 保存供应商连接（若填了 base/key）
      if (baseUrl.trim() && provider.trim()) {
        await apiPost('/admin/provider-connections', {
          provider: provider.trim(), tier: modelTier, label: label.trim() || provider.trim(),
          baseUrl: baseUrl.trim(), apiKeys: apiKeys.map((k) => k.trim()).filter(Boolean),
          apiLimit, carrierLimit, enabled: true,
        }).catch(() => {});
      }
      await apiPost('/admin/models', {
        apiModel: apiModel.trim(),
        displayName: apiModel.trim(),
        provider: provider.trim() || 'custom',
        vendor: vendor.trim(),
        tier: modelTier,
        costPer1M: modelTier === 'FREE' ? 0 : Math.max(0, parseFloat(credits1M) || 0),
        rateLimit: modelLimit,
      });
      flash(`模型 ${apiModel} 已保存`);
      setApiModel(''); setVendor(''); setCredits1M('0'); setModelLimit(emptyLimit()); setModelList(null);
      refresh();
    } catch (e: any) { flash(`保存失败：${e?.message || ''}`); }
    finally { setSaving(false); }
  };

  const delModel = async (k: string) => {
    if (!confirm(`删除模型 ${k}？`)) return;
    try { await apiDelete(`/admin/models/${encodeURIComponent(k)}`); flash(`模型 ${k} 已删除`); refresh(); }
    catch (e: any) { flash(`删除失败：${e?.message || ''}`); }
  };

  // ============ 改价（不删模型，直接 PUT 覆盖价格） ============
  // 旧做法只能改完后用添加表单重新 POST，而 POST 是 upsert、需带全部字段，
  // 等于让人把厂商/限额/能力之类一并重填一遍，漏填的会写成默认值。
  //
  // 只改一个模型的价格时，先全量拉本地拼 body 成本太高；让服务端接受部分字段，
  // 前端便只需传 costPer1M 与 tier。
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [savingPrice, setSavingPrice] = useState<string | null>(null);

  const editModelPrice = async (m: ModelRow) => {
    const raw = priceEdits[m.modelKey];
    if (raw === undefined) return;
    const v = raw.trim() === '' ? 0 : Number(raw);
    if (!Number.isFinite(v) || v < 0) { flash('价格必须是非负数字'); return; }
    setSavingPrice(m.modelKey);
    try {
      // 只传要改的字段：后端 update 分支保证未传字段不变。
      await apiPut(`/admin/models/${encodeURIComponent(m.modelKey)}`, {
        tier: m.tier,
        costPer1M: m.tier === 'FREE' ? 0 : v,
      });
      // 本地同步，避免 render() 全量刷新后表格闪白
      setModels((prev) => prev.map((x) => (x.modelKey === m.modelKey
        ? { ...x, costPer1k: m.tier === 'FREE' ? 0 : v / 1000 }
        : x)));
      flash(`${m.displayName || m.modelKey} 价格已更新`);
    } catch (e: any) { flash(`改价失败：${e?.message || ''}`); }
    finally { setSavingPrice(null); }
  };

  const tConns = connections.filter((c) => c.tier === tier);
  const tModels = models.filter((m) => m.tier === tier);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between anim-fade-up">
        <h1 className="text-2xl font-display font-bold text-primary">模型管理</h1>
        <div className="flex gap-1 rounded-capsule bg-surface/60 p-0.5">
          {(['FREE', 'PRO'] as Tier[]).map((t) => (
            <button key={t} onClick={() => setTier(t)}
              className={`px-3 py-1 text-xs rounded-capsule transition-[background-color,border-color,box-shadow,opacity,transform,color] ${tier === t ? 'bg-accent text-on-accent' : 'text-muted'}`}>
              {t === 'FREE' ? '免费用户' : 'Pro用户'}
            </button>
          ))}
        </div>
      </div>

      {toast && <div className="px-4 py-2.5 rounded-card liquid-glass text-xs text-primary anim-fade-up sticky top-3 z-10">{toast}</div>}

      {/* ============ 供应商连接 ============ */}
      <section className="glass-card-sm p-4 space-y-3 anim-fade-up">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-display font-semibold text-primary">供应商连接（{tier === 'FREE' ? '免费用户' : 'Pro用户'}）</h2>
        </div>

        {tConns.length === 0 ? (
          <div className="text-xs text-muted py-3 text-center border border-dashed border-border rounded-card">暂无该层级的供应商连接</div>
        ) : (
          <div className="grid gap-2">
            {tConns.map((c) => (
              <div key={`${c.provider}-${c.tier}`} className="flex items-center gap-3 p-3 rounded-card border border-border/50">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-primary">{c.label || c.provider}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-capsule bg-accent/10 text-accent font-mono">{c.provider}</span>
                    <span className="text-[10px] text-muted/70 truncate font-mono">{c.baseUrl}</span>
                  </div>
                  <div className="text-[11px] text-muted mt-1">密钥 {(c.apiKeys || []).length} 把（无上限）
                    {hasLimit(c.apiLimit) && ' · 单API限'}{hasLimit(c.carrierLimit) && ' · 运营商限'}</div>
                </div>
                <button onClick={() => delConn(c.provider, c.tier)} className="text-[11px] px-2.5 py-1 rounded-capsule border border-border text-muted hover:text-error hover:border-error/40">删除</button>
              </div>
            ))}
          </div>
        )}

        {/* 新建 / 编辑连接 */}
        <div className="space-y-3 pt-1">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>名称（provider）</label>
              <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="如 agnes" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>显示名（可选）</label>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如 agnes" className={inputCls} />
            </div>
          </div>
          <div>
            <label className={labelCls}>完整 URL（不再拼接，直接 POST）</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://apihub.agnes-ai.com/v1/chat/completions" className={inputCls} />
          </div>

          <div>
            <label className={labelCls}>API KEY（无数量上限，轮询使用）</label>
            {apiKeys.map((k, i) => (
              <div key={i} className="flex items-center gap-2 mb-1.5">
                <span className="w-14 text-[11px] text-muted shrink-0">{i === 0 ? 'API KEY' : `API ${i + 1}`}</span>
                <input type="password" value={k} onChange={(e) => { const n = [...apiKeys]; n[i] = e.target.value; setApiKeys(n); }}
                  placeholder="sk-…" className="flex-1 bg-bg border border-border rounded-card px-3 py-1.5 text-xs font-mono" />
                {apiKeys.length > 1 && (
                  <button onClick={() => setApiKeys(apiKeys.filter((_, j) => j !== i))} className="text-muted hover:text-error text-xs">✕</button>
                )}
              </div>
            ))}
            <button onClick={() => setApiKeys([...apiKeys, ''])}
              className="px-2.5 py-1 text-[11px] rounded-capsule border border-dashed border-border text-muted hover:text-accent hover:border-accent/40">＋ 添加 API</button>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] text-muted mb-1.5 font-medium">单 API 限制（每把 key 独立额度）</div>
              <RateLimitEditor value={apiLimit} onChange={setApiLimit} />
            </div>
            <div>
              <div className="text-[11px] text-muted mb-1.5 font-medium">运营商限制（该供应商所有 API 统一额度）</div>
              <RateLimitEditor value={carrierLimit} onChange={setCarrierLimit} />
            </div>
          </div>

          <button onClick={connSave} className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-on-accent rounded-card font-medium anim-press">
            保存供应商连接
          </button>
        </div>
      </section>

      {/* ============ 添加模型 ============ */}
      <section className="glass-card-sm p-4 space-y-3 anim-fade-up">
        <h2 className="text-sm font-display font-semibold text-primary">添加模型（{tier === 'FREE' ? '免费' : 'Pro'}）</h2>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <label className={labelCls}>模型名称</label>
            <input value={apiModel} onChange={(e) => setApiModel(e.target.value)} placeholder="如 openai/gpt-6-luna-decisions" className={inputCls} />
          </div>
          <button onClick={fetchList} disabled={fetching}
            className="mt-[22px] px-3.5 py-2 text-xs rounded-card border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-40 anim-press">
            {fetching ? '拉取中…' : '拉取列表'}
          </button>
        </div>
        {modelList && modelList.length > 0 && (
          <div className="border border-border rounded-card overflow-hidden">
            <div className="text-[11px] text-muted px-3 py-1.5 bg-surface/60 border-b border-border/60">模型清单（{modelList.length}）— 点击填入</div>
            <div className="max-h-44 overflow-y-auto divide-y divide-border/40">
              {modelList.map((m: any) => (
                <button key={m.id} onClick={() => { setApiModel(m.id); setModelList(null); }}
                  className="w-full text-left px-3 py-2 text-xs font-mono text-muted hover:text-primary hover:bg-surface-hover">
                  {m.id}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="grid md:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>厂商分类（可留空按 provider 自动）</label>
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="如 ChatGPT / Claude" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>层级</label>
            <select value={modelTier} onChange={(e) => setModelTier(e.target.value as Tier)} className={inputCls}>
              <option value="FREE">免费版</option>
              <option value="PRO">Pro 版</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>积分 / 1M token（0=免费，手动输入）</label>
            <input type="number" min="0" value={credits1M} disabled={modelTier === 'FREE'}
              onChange={(e) => setCredits1M(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted mb-1.5 font-medium">调用模型限制（该模型独立额度）</div>
          <RateLimitEditor value={modelLimit} onChange={setModelLimit} showModelHint />
        </div>
        <button onClick={saveModel} disabled={saving}
          className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-on-accent rounded-card font-medium anim-press disabled:opacity-50">
          {saving ? '保存中…' : '保存模型'}
        </button>
      </section>

      {/* ============ 模型列表 ============ */}
      <section className="space-y-2 anim-fade-up">
        <h2 className="text-sm font-display font-semibold text-primary">模型列表（{tier === 'FREE' ? '免费' : 'Pro'}，{tModels.length}）</h2>
        <div className="glass-card-sm overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px] admin-table">
            <thead>
              <tr className="border-b border-border">
                {['模型', '厂商', 'Provider', '积分/1M', '限额', '操作'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] text-muted font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tModels.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-4 text-center text-xs text-muted">暂无</td></tr>
              ) : tModels.map((m) => (
                <tr key={m.modelKey} className="border-b border-border/40 hover:bg-surface-hover/40">
                  <td className="px-4 py-2.5 text-xs font-mono text-primary" data-label="模型">{m.apiModel || m.modelKey}</td>
                  <td className="px-4 py-2.5 text-xs text-muted" data-label="厂商">{m.vendor || autoVendor(m.provider)}</td>
                  <td className="px-4 py-2.5 text-xs text-muted font-mono" data-label="Provider">{m.provider}</td>
                  <td className="px-4 py-2.5 text-xs text-muted" data-label="积分/1M">
                    {m.tier === 'FREE' ? (
                      <span className="text-muted">免费</span>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={Math.round(m.costPer1k * 1000)}
                          onChange={(e) => setPriceEdits((p) => ({ ...p, [m.modelKey]: e.target.value }))}
                          className={`${inputCls} !w-24 !px-2 !py-1 text-xs`}
                          placeholder="0"
                        />
                        <button
                          onClick={() => editModelPrice(m)}
                          disabled={savingPrice === m.modelKey || priceEdits[m.modelKey] === undefined}
                          className="text-[11px] px-2 py-1.5 rounded-capsule border border-border text-muted hover:text-accent hover:border-accent/40 disabled:opacity-40">
                          {savingPrice === m.modelKey ? '保存中…' : '保存价格'}
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted" data-label="限额">{hasLimit(m.rateLimit) ? '有限额' : '—'}</td>
                  <td className="px-4 py-2.5 text-right" data-label="操作">
                    <button onClick={() => delModel(m.modelKey)}
                      className="text-[11px] px-2 py-1.5 rounded-capsule border border-border text-muted hover:text-error hover:border-error/40">删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------- helpers ----------------
function safeObj(v: any): Partial<RateLimitBlock> {
  if (!v) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return v;
}
function hasLimit(b: any): boolean {
  if (!b) return false;
  // 空串/'-' 都视为"无限制"，不算已配置（与后端 parseRateLimitBlock 口径一致）
  const eff = (v: any) => typeof v === 'string' && (v.trim() === '' || v.trim() === '-') ? null : v;
  return ['rpm', 'tpm', 'rpd', 'maxParallel', 'tpd'].some((k) => {
    const v = eff((b as any)?.[k]);
    return v !== null && v !== undefined;
  });
}
function autoVendor(provider: string): string {
  const map: Record<string, string> = { openai: 'ChatGPT', anthropic: 'Claude', google: 'Gemini', deepseek: 'DeepSeek', xiaomi: 'Xiaomi MiMO', agnes: 'Agnes' };
  return map[provider] || provider;
}



