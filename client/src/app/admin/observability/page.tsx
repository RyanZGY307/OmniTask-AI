'use client';
import { useEffect, useState, useCallback } from 'react';
import { apiGet } from '@/lib/api';

// ================================================================
// 系统观测中心（System Observability Center）
// 五个区域：运行总览 / 数据库详情 / 数据存储分类 / AI 决策与执行 / 事件审计
//
// 设计底线：
//  · 数据全部来自真实 API；取不到的一律渲染「未知 / 暂未接入 / 容量不可获取」，
//    绝不把缺失当 0。
//  · AI 摘要强制 24h：页面只渲染 remainingSeconds > 0 的行，到期显示已清理。
//  · 无图表库依赖：占比用纯 SVG（项目 client 未装图表库）。
// ================================================================

const fmtBytes = (v: any): string => {
  if (v === null || v === undefined) return '未知';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '未知';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1, x = n;
  do { x /= 1024; i++; } while (x >= 1024 && i < u.length - 1);
  return `${x.toFixed(x < 10 ? 2 : 1)} ${u[i]}`;
};

const fmtNum = (v: any, dash = '未知'): string => {
  if (v === null || v === undefined) return dash;
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : dash;
};

const ageText = (sec: number | null): string => {
  if (sec === null) return '从未采集';
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  return `${Math.floor(sec / 3600)} 小时前`;
};

const hhmmss = (s: number): string => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const STATUS_BADGE: Record<string, string> = {
  available: 'bg-success/15 text-success border-success/30',
  unavailable: 'bg-error/15 text-error border-error/30',
  unknown: 'bg-warning/15 text-warning border-warning/30',
};

function Donut({ items, total, size = 168 }: { items: { label: string; value: number; color: string }[]; total: number; size?: number }) {
  const sum = items.reduce((a, b) => a + (b.value > 0 ? b.value : 0), 0) || 1;
  const r = size / 2 - 4;
  const c = size / 2;
  let acc = 0;
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" role="img" aria-label="占比图">
        <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth={16} className="text-border" />
        {items.map((it, i) => {
          const frac = (it.value > 0 ? it.value : 0) / sum;
          if (frac <= 0) return null;
          const a0 = acc * 2 * Math.PI - Math.PI / 2;
          acc += frac;
          const a1 = acc * 2 * Math.PI - Math.PI / 2;
          const large = frac > 0.5 ? 1 : 0;
          const p = (ang: number, rad = r) => `${c + rad * Math.cos(ang)},${c + rad * Math.sin(ang)}`;
          return (
            <path key={i} d={`M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}`} fill="none"
              stroke={it.color} strokeWidth={16} strokeLinecap="butt" />
          );
        })}
        <text x={c} y={c - 4} textAnchor="middle" className="fill-current text-primary" style={{ fontSize: 17, fontWeight: 700 }}>
          {total > 0 ? `${Math.round((items.reduce((a, b) => a + (b.value > 0 ? b.value : 0), 0) / (total || 1)) * 100)}%` : '—'}
        </text>
        <text x={c} y={c + 13} textAnchor="middle" className="fill-current text-muted" style={{ fontSize: 10 }}>
          已分类
        </text>
      </svg>
      <ul className="text-xs space-y-1.5 flex-1 w-full">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: it.color }} />
            <span className="text-muted truncate flex-1">{it.label}</span>
            <span className="font-mono text-primary">{fmtBytes(it.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Bar({ rows }: { rows: { label: string; value: number; note?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => (
        <li key={i}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-muted truncate mr-2">{r.label}</span>
            <span className="font-mono text-primary shrink-0">{fmtBytes(r.value)}</span>
          </div>
          <div className="h-2 bg-border/60 rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-[background-color,border-color,box-shadow,opacity,transform,color]" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />
          </div>
          {r.note && <div className="text-[10px] text-muted mt-0.5">{r.note}</div>}
        </li>
      ))}
    </ul>
  );
}

const PALETTE = ['#7c8cf8', '#5ecfa6', '#f2b35c', '#f2795e', '#9b8af0', '#4fb8d8', '#c77ddb', '#8fbf6b'];

export default function AdminObservabilityCenter() {
  const [overview, setOverview] = useState<any>(null);
  const [databases, setDatabases] = useState<any[]>([]);
  const [cats, setCats] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [purgeLogs, setPurgeLogs] = useState<any[]>([]);
  const [storage, setStorage] = useState<any>(null);
  const [activeDomain, setActiveDomain] = useState<string>('');
  const [tab, setTab] = useState<'storage' | 'ai' | 'events'>('storage');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [ov, dbs, ct, ar, ev, pl] = await Promise.all([
        apiGet('/admin/observability/overview').catch(() => null),
        apiGet('/admin/observability/databases').catch(() => null),
        apiGet('/admin/observability/storage/categories?window=24h').catch(() => null),
        apiGet('/admin/observability/ai-runs?limit=30').catch(() => null),
        apiGet('/admin/observability/events?limit=40').catch(() => null),
        apiGet('/admin/observability/purge?limit=5').catch(() => null),
      ]);
      if (!ov && !dbs) { setError('运行总览与数据库列表均不可用：观测调度可能未运行或尚未采集到数据'); }
      setOverview(ov); setDatabases(dbs?.databases ?? []);
      setCats(ct); setRuns(ar?.items ?? []);
      setEvents(ev?.items ?? []); setPurgeLogs(pl?.items ?? []);
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  // 每 30s 刷新一次倒计时（24h 剩余时间）
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 30000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!activeDomain && databases.length) setActiveDomain(databases[0].domain);
  }, [databases, activeDomain]);

  useEffect(() => {
    if (!activeDomain) return;
    apiGet(`/admin/observability/databases/${activeDomain}/storage`)
      .then(setStorage).catch(() => setStorage(null));
  }, [activeDomain]);

  const Card = ({ title, hint, children, className = '' }: any) => (
    <section className={`liquid-glass p-4 sm:p-5 anim-fade-up ${className}`}>
      <div className="flex items-baseline justify-between mb-3 gap-2 flex-wrap">
        <h2 className="text-sm font-display font-bold text-primary">{title}</h2>
        {hint && <span className="text-[10px] text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );

  const Stat = ({ label, value, sub }: any) => (
    <div className="liquid-glass p-3.5">
      <div className="text-[11px] text-muted mb-1">{label}</div>
      <div className="text-xl font-display font-bold text-primary leading-tight">{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1 leading-snug">{sub}</div>}
    </div>
  );

  if (loading && !overview && !databases.length) {
    return <div className="flex justify-center py-20"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>;
  }

  return (
    <div className="space-y-5">
      {/* ============ 3.1 运行总览 ============ */}
      <div className="flex items-start justify-between gap-3 flex-wrap anim-fade-up">
        <div>
          <h1 className="text-2xl font-display font-bold text-primary">系统观测中心</h1>
          <p className="text-xs text-muted mt-1">
            System Observability Center · 指标为只读采集，不暴露连接串，页面不提供任意 SQL 执行
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-[10px] text-muted">
              刷新于 {lastRefresh.toLocaleTimeString('zh-CN')}
              {overview?.stale && <span className="text-warning ml-1">· 数据陈旧</span>}
            </span>
          )}
          <button onClick={load} className="px-3 py-2 bg-accent hover:bg-accent-hover text-on-accent text-xs rounded-card anim-press">刷新</button>
        </div>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-card p-3 text-xs text-error anim-fade-up">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <Stat label="已登记数据库" value={fmtNum(overview?.databases?.registered)}
          sub="来自采集登记表，随新接入自动增加" />
        <Stat label="当前可连接" value={`${fmtNum(overview?.databases?.available)} / ${fmtNum(overview?.databases?.registered)}`}
          sub={`不可用 ${fmtNum(overview?.databases?.unavailable)} · 未知 ${fmtNum(overview?.databases?.unknown)}`} />
        <Stat label="数据库逻辑占用总量" value={fmtBytes(overview?.totals?.logicalSizeBytes)}
          sub="各库 pg_database_size 之和，非实例磁盘用量" />
        <Stat label="实例磁盘已用量" value={fmtBytes(overview?.instance?.diskUsedBytes)}
          sub="同实例多库只统计一次，按 instanceId 去重" />
        <Stat label="实例实际总容量" value={overview?.instance?.diskTotalBytes == null ? '容量不可获取' : fmtBytes(overview.instance.diskTotalBytes)}
          sub={overview?.instance?.note || '未用数据库大小顶替容量'} />
        <Stat label="可用磁盘空间" value={overview?.instance?.diskAvailableBytes == null ? '未知' : fmtBytes(overview.instance.diskAvailableBytes)}
          sub="仅在托管平台提供可靠指标时显示" />
        <Stat label="磁盘使用率"
          value={overview?.instance?.utilizationPercent == null ? '未知' : `${overview.instance.utilizationPercent}%`}
          sub="使用量 ÷ 实际容量；容量缺失则不自算" />
        <Stat label="AI 任务（运行/等待/验证）"
          value={`${fmtNum(overview?.aiTasks?.running, '0')} / ${fmtNum(overview?.aiTasks?.queued, '0')} / ${fmtNum(overview?.aiTasks?.verifying, '0')}`}
          sub={`失败 ${fmtNum(overview?.aiTasks?.failed, '0')} · 完成 ${fmtNum(overview?.aiTasks?.completed, '0')}`} />
        <Stat label="最近一次采集" value={overview?.lastCollectedAt ? ageText(overview.collectionAgeSeconds) : '从未采集'}
          sub={overview?.lastCollectedAt ? new Date(overview.lastCollectedAt).toLocaleString('zh-CN') : '观测调度未运行或采集未完成'} />
        <Stat label="未处理严重异常" value={fmtNum(overview?.criticalEvents?.count, '0')}
          sub={overview?.criticalEvents?.items?.length ? overview.criticalEvents.items[0].title : '无未处理严重事件'} />
      </div>

      {/* ============ 3.2 数据库详情 ============ */}
      <Card title="数据库详情" hint="逻辑占用 ≠ 实例磁盘已用 ≠ 实例总容量；容量字段缺失时显示不可获取">
        {databases.length === 0 ? (
          <div className="text-xs text-muted py-6 text-center">尚无数据库采集记录</div>
        ) : (
          <>
            <div className="space-y-2 md:hidden">
              {databases.map((d) => (
                <div key={d.domain} className="border border-border/60 rounded-card p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-bold text-primary">{d.dbName}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded border ${STATUS_BADGE[d.connectionStatus] || STATUS_BADGE.unknown}`}>
                      {d.connectionStatus === 'available' ? '可用' : d.connectionStatus === 'unavailable' ? '不可用' : '未知'}
                    </span>
                  </div>
                  <dl className="text-[11px] space-y-1 text-muted">
                    <div className="flex justify-between"><dt>逻辑占用</dt><dd className="font-mono text-primary">{fmtBytes(d.sizeBytes)}</dd></div>
                    <div className="flex justify-between"><dt>24h 增长</dt><dd className="font-mono text-primary">{fmtBytes(d.growthBytes24h)}</dd></div>
                    <div className="flex justify-between"><dt>所属实例</dt><dd className="font-mono">{d.instanceId ?? '未知'}</dd></div>
                    <div className="flex justify-between"><dt>实例已用 / 容量</dt><dd className="font-mono">
                      {fmtBytes(d.instanceDiskUsedBytes)} / {d.instanceDiskTotalBytes == null ? '不可获取' : fmtBytes(d.instanceDiskTotalBytes)}
                    </dd></div>
                  </dl>
                </div>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted border-b border-border/60">
                    <th className="text-left py-2 font-normal">数据库</th>
                    <th className="text-left py-2 font-normal">连接状态</th>
                    <th className="text-right py-2 font-normal">逻辑占用</th>
                    <th className="text-right py-2 font-normal">24h 增长</th>
                    <th className="text-right py-2 font-normal">所属实例</th>
                    <th className="text-right py-2 font-normal">实例已用</th>
                    <th className="text-right py-2 font-normal">实例容量</th>
                    <th className="text-right py-2 font-normal">使用率</th>
                    <th className="text-right py-2 font-normal">最近采集</th>
                    <th className="text-left py-2 font-normal pl-2">异常状态</th>
                  </tr>
                </thead>
                <tbody>
                  {databases.map((d) => (
                    <tr key={d.domain} className="border-b border-border/30 hover:bg-surface-hover/20">
                      <td className="py-2 text-primary font-medium">{d.dbName}<div className="text-[10px] text-muted">{d.domain}</div></td>
                      <td className="py-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded border ${STATUS_BADGE[d.connectionStatus] || STATUS_BADGE.unknown}`}>
                          {d.connectionStatus === 'available' ? '可用' : d.connectionStatus === 'unavailable' ? '不可用' : '未知'}
                        </span>
                      </td>
                      <td className="py-2 text-right font-mono text-primary">{fmtBytes(d.sizeBytes)}</td>
                      <td className="py-2 text-right font-mono text-muted">{fmtBytes(d.growthBytes24h)}</td>
                      <td className="py-2 text-right font-mono text-muted">{d.instanceId ?? '未知'}</td>
                      <td className="py-2 text-right font-mono text-muted">{fmtBytes(d.instanceDiskUsedBytes)}</td>
                      <td className="py-2 text-right font-mono text-muted">
                        {d.instanceDiskTotalBytes == null ? <span className="text-warning">不可获取</span> : fmtBytes(d.instanceDiskTotalBytes)}
                      </td>
                      <td className="py-2 text-right font-mono text-muted">
                        {d.utilizationPercent == null ? '未知' : `${d.utilizationPercent}%`}
                      </td>
                      <td className="py-2 text-right font-mono text-muted text-[10px]">
                        {d.lastCapturedAt ? new Date(d.lastCapturedAt).toLocaleString('zh-CN') : '未采集'}
                      </td>
                      <td className="py-2 pl-2 text-muted text-[10px]">{d.errorCode ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {/* ============ 3.3 数据存储分类 ============ */}
      <Card title="数据存储分类" hint={`${cats?.window || '24h'} · 采集基准 ${cats?.basis || '最近一次采集'} · 单位字节`}>
        {!cats || cats.empty ? (
          <div className="text-xs text-muted py-6 text-center">
            尚无存储明细采集。表级统计由 OBS_STORAGE_INTERVAL_MS（默认 30 分钟）触发，不会因页面刷新而重复扫描。
          </div>
        ) : (
          <div className="grid lg:grid-cols-3 gap-5">
            <div>
              <h3 className="text-xs font-bold text-primary mb-2">按业务领域</h3>
              <Donut items={(cats.byDomain ?? []).map((x: any, i: number) => ({
                label: x.key === 'unclassified' ? '待识别' : x.key,
                value: x.bytes, color: x.key === 'unclassified' ? '#8a8a8a' : PALETTE[i % PALETTE.length],
              }))} total={cats.totalBytes} />
            </div>
            <div>
              <h3 className="text-xs font-bold text-primary mb-2">按数据库</h3>
              <Bar rows={(cats.byDatabase ?? []).map((x: any) => ({ label: x.dbName, value: x.bytes }))} />
              <h3 className="text-xs font-bold text-primary mt-4 mb-2">按物理存储类型</h3>
              <Bar rows={(cats.byPhysicalType ?? []).map((x: any) => ({ label: x.kind, value: x.bytes, note: x.note }))} />
            </div>
            <div>
              <h3 className="text-xs font-bold text-primary mb-2">Schema 与表排名</h3>
              {activeDomain && (
                <div className="flex gap-1 mb-2 flex-wrap">
                  {databases.map((d) => (
                    <button key={d.domain} onClick={() => setActiveDomain(d.domain)}
                      className={`px-2 py-1 text-[10px] rounded border anim-press ${activeDomain === d.domain ? 'bg-accent/20 border-accent/40 text-accent' : 'border-border text-muted'}`}>
                      {d.dbName}
                    </button>
                  ))}
                </div>
              )}
              {!storage || !storage.entries?.length ? (
                <div className="text-xs text-muted py-4 text-center">该库尚无明细采集</div>
              ) : (
                <Bar rows={storage.entries.slice(0, 10).map((t: any) => ({
                  label: `${t.schemaName}.${t.tableName}`,
                  value: t.totalBytes,
                  note: `${t.businessCategory === 'unclassified' ? '待识别' : t.businessCategory} · 置信度 ${t.categoryConfidence} · 行数估 ${fmtNum(t.rowEstimate, '—')}`,
                }))} />
              )}
              {cats.unclassified?.bytes > 0 && (
                <div className="mt-3 text-[10px] text-warning">
                  未归类 {fmtBytes(cats.unclassified.bytes)}（{cats.unclassified.percent}%）：{cats.unclassified.note}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ============ tab：AI 决策 / 事件审计 / 清理记录 ============ */}
      <div className="flex gap-2 border-b border-border/60 pb-2 anim-fade-up">
        {[
          { k: 'ai' as const, l: 'AI 决策与执行' },
          { k: 'events' as const, l: '事件与异常审计' },
        ].map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={`px-3 py-1.5 text-xs rounded-card anim-press ${tab === t.k ? 'bg-accent/20 text-accent' : 'text-muted hover:text-primary'}`}>
            {t.l}
          </button>
        ))}
      </div>

      {tab === 'ai' && (
        <Card title="AI 决策与执行" hint="摘要仅保留 24 小时，到期由后台任务物理删除；剩余时间实时倒计时">
          {runs.length === 0 ? (
            <div className="text-xs text-muted py-6 text-center">
              最近 24 小时内没有 AI 运行摘要。摘要由只读投影生成（不改动核心系统）。
            </div>
          ) : (
            <div className="space-y-3">
              {runs.map((r: any) => {
                const expired = r.remainingSeconds <= 0;
                return (
                  <details key={r.id} className="border border-border/60 rounded-card p-3 group" open>
                    <summary className="cursor-pointer list-none flex items-start justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent font-mono">{r.taskKind}</span>
                        <span className="text-xs text-primary font-medium">{r.goal || r.summary || '（无目标描述）'}</span>
                        {r.modelUsed && <span className="text-[10px] text-muted font-mono">{r.modelUsed}</span>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[10px] font-mono ${expired ? 'text-error' : 'text-muted'}`}>
                          {expired ? '已过期清理' : `剩余 ${hhmmss(r.remainingSeconds)}`}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                          r.status === 'COMPLETED' || r.status === 'completed' ? 'border-success/30 text-success'
                            : r.status === 'FAILED' ? 'border-error/30 text-error'
                              : 'border-warning/30 text-warning'}`}>{r.status}</span>
                      </div>
                    </summary>

                    <div className="mt-3 grid gap-3 text-xs">
                      {/* 四类信息严格分区 */}
                      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                        <Block title="① AI 提出的计划" empty={!r.decision}>
                          {r.decision && (
                            <>
                              {r.decision.candidates && <KV k="候选方案" v={JSON.stringify(r.decision.candidates)} />}
                              <KV k="选用理由" v={r.decision.chosenReason ?? r.decision.selectionReason} />
                              <KV k="预期收益" v={r.decision.expectedBenefit} />
                              <KV k="主要风险" v={r.decision.risks} />
                              <KV k="未采用原因" v={r.decision.rejectedReasons} />
                            </>
                          )}
                        </Block>
                        <Block title="② 程序化门禁结果" empty={!r.guard?.available}>
                          {r.guard ? (
                            !r.guard.available
                              ? <span className="text-warning">未接入：{r.guard.reason}</span>
                              : <KV k="校验" v={JSON.stringify(r.guard.checks)} />
                          ) : <span className="text-warning">未接入</span>}
                        </Block>
                        <Block title="③ 实际执行事件" empty={!r.tools?.linked}>
                          {r.tools?.linked
                            ? (r.tools.items ?? []).map((t: any, i: number) => (
                                <KV key={i} k={t.name} v={`${t.status}${t.errorCode ? ` (${t.errorCode})` : ''}`} />
                              ))
                            : <span className="text-warning">未关联：{r.tools?.reason || '该任务类型未与工具调用表关联'}</span>}
                        </Block>
                        <Block title="④ 执行后实测结果" empty={!r.outcome}>
                          {r.outcome && (
                            <>
                              <KV k="结果" v={r.outcome.status ?? r.outcome.result} />
                              <KV k="实测指标" v={r.outcome.metricsAfterNote ?? (r.outcome.metricsBefore || r.outcome.metricsAfter ? JSON.stringify({ before: r.outcome.metricsBefore, after: r.outcome.metricsAfter }) : '未接入')} />
                              <KV k="处置" v={r.outcome.verdict ?? (r.outcome.lastError ? `失败：${r.outcome.lastError}` : '未记录')} />
                            </>
                          )}
                        </Block>
                      </div>

                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted">
                        <span>触发来源：{r.triggerSource}</span>
                        {r.agentName && <span>Agent：{r.agentName}</span>}
                        <span>开始：{r.startedAt ? new Date(r.startedAt).toLocaleString('zh-CN') : '未知'}</span>
                        <span>结束：{r.completedAt ? new Date(r.completedAt).toLocaleString('zh-CN') : '未完成'}</span>
                        <span>任务ID：<span className="font-mono">{r.taskId}</span></span>
                        {r.relatedTraceIds?.length > 0 && (
                          <span>关联链路：<span className="font-mono">{r.relatedTraceIds[0]}</span></span>
                        )}
                        {r.redactionApplied?.length > 0 && <span className="text-success">已脱敏：{r.redactionApplied.join(', ')}</span>}
                      </div>
                      <p className="text-[11px] text-muted leading-relaxed">{r.summary}</p>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
          <div className="mt-4 border-t border-border/40 pt-3">
            <h3 className="text-xs font-bold text-primary mb-2">24h 清理记录</h3>
            {purgeLogs.length === 0 ? (
              <div className="text-[11px] text-muted">尚无清理记录。清理任务启动即跑一次，随后每分钟一次。</div>
            ) : (
              <ul className="text-[11px] space-y-1">
                {purgeLogs.map((p: any) => (
                  <li key={p.id} className="flex flex-wrap gap-x-3 text-muted">
                    <span className="font-mono">{new Date(p.startedAt).toLocaleTimeString('zh-CN')}</span>
                    <span>{p.mode}</span>
                    <span>删除 {p.deletedCount}</span>
                    <span>耗时 {p.latencyMs}ms</span>
                    <span>{p.leaseAcquired ? '已获取锁' : '其他实例执行中（让位）'}</span>
                    {p.errorMessage && <span className="text-error">失败：{p.errorMessage}</span>}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-muted mt-2">
              空间说明：DELETE 不立即缩小 OS 层数据库文件，回收空间由 autovacuum 复用；本设计不执行 VACUUM FULL 或表重写。
            </p>
          </div>
        </Card>
      )}

      {tab === 'events' && (
        <Card title="事件与异常审计" hint="长期元数据保留；detail 不含摘要正文、连接串与密钥">
          {events.length === 0 ? (
            <div className="text-xs text-muted py-6 text-center">暂无事件记录</div>
          ) : (
            <ol className="relative border-l border-border/60 ml-2 space-y-4">
              {events.map((e: any) => (
                <li key={e.id} className="ml-4">
                  <span className={`absolute -left-[5px] w-2.5 h-2.5 rounded-full ${
                    e.severity === 'critical' ? 'bg-error' : e.severity === 'error' ? 'bg-error/70'
                      : e.severity === 'warning' ? 'bg-warning' : 'bg-accent/60'}`} />
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[10px] text-muted font-mono">{new Date(e.ts).toLocaleString('zh-CN')}</span>
                    <span className="text-xs text-primary font-medium">{e.title}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface text-muted font-mono">{e.kind}</span>
                    {!e.resolved && <span className="text-[10px] text-warning">未处理</span>}
                  </div>
                  {e.detail && <p className="text-[11px] text-muted mt-1 leading-relaxed">{e.detail}</p>}
                  <div className="flex flex-wrap gap-x-3 text-[10px] text-muted mt-0.5">
                    {e.domain && <span>库：{e.domain}</span>}
                    {e.taskId && <span>任务：<span className="font-mono">{e.taskId}</span></span>}
                    {e.payloadRef && <span>证据：<span className="font-mono">{e.payloadRef}</span></span>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}
      {/* tick 用于驱动倒计时刷新，不渲染任何内容 */}
      <span className="hidden" aria-hidden>{tick}</span>
    </div>
  );
}

function Block({ title, empty, children }: any) {
  return (
    <div className="border border-border/50 rounded-card p-2.5">
      <div className="text-[10px] text-muted mb-1.5">{title}</div>
      {empty ? <span className="text-[11px] text-muted">未记录</span>
        : <div className="space-y-1">{children}</div>}
    </div>
  );
}

function KV({ k, v }: any) {
  if (v === null || v === undefined || v === '') return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="text-muted shrink-0">{k}</span>
      <span className="text-primary break-all min-w-0">{String(s).slice(0, 300)}</span>
    </div>
  );
}
