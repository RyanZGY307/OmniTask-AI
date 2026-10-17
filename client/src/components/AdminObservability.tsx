'use client';
import { getApiUrl } from '@/lib/api';
import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/store/authStore';

/* ============================================================
   Types
   ============================================================ */

interface Stats {
  period: string;
  totalRequests: number;
  successRate: number;
  errorRate: number;
  totalTokens: number;
  totalCreditsUsed: number;
  totalApiCostUsd: number;
  avgLatencyMs: number;
  perModel: {
    model: string;
    requests: number;
    totalTokens: number;
    totalCostUsd: number;
    avgLatencyMs: number;
    errorRate: number;
  }[];
}

interface Trace {
  id: string;
  requestId: string;
  userId: string;
  createdAt: string;
  durationMs: number | null;
  status: string;
  selectedModel: string | null;
  provider: string | null;
  mode: string | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  creditsCharged: number | null;
  totalApiCostUsd: number | null;
  ttftMs: number | null;
  finishReason: string | null;
}

interface TraceDetail {
  trace: Trace & {
    events: any[];
    modelCalls: any[];
    toolCalls: any[];
    errors: any[];
    billingTransactions: any[];
    conversationId?: string;
    requestedModel?: string;
    routingMode?: string;
    selectionReason?: string;
    streamInterrupted?: boolean;
    creditsBefore?: number;
    creditsAfter?: number;
    inputCostUsd?: number;
    outputCostUsd?: number;
  };
}

/* ============================================================
   Helpers
   ============================================================ */

const API = getApiUrl();

async function fetchAdmin(path: string, token: string, params?: Record<string, string>) {
  const url = new URL(`${API}/admin/observability${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtMs(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n >= 1000) return (n / 1000).toFixed(2) + 's';
  return n + 'ms';
}

function statusColor(s: string): string {
  switch (s) {
    case 'SUCCESS': return '#22c55e';
    case 'PARTIAL_SUCCESS': return '#f59e0b';
    case 'FAILED': case 'TIMEOUT': return '#ef4444';
    case 'CANCELLED': return '#6b7280';
    case 'RATE_LIMITED': return '#f97316';
    default: return '#6b7280';
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function eventTypeColor(type: string): string {
  const colors: Record<string, string> = {
    REQUEST: '#a1a1aa', ROUTER: '#8B5CF6', MODEL: '#22c55e', TOOL: '#f59e0b',
    RETRIEVAL: '#06b6d4', STREAM: '#10b981', RETRY: '#f97316', FALLBACK: '#ec4899',
    VALIDATION: '#6366f1', ERROR: '#ef4444', BILLING: '#eab308', AUDIT: '#6b7280',
  };
  return colors[type] || '#6b7280';
}

/* ============================================================
   Sub-Components
   ============================================================ */

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="glass-card-sm" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: color || 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'monospace', color: color || 'var(--text-primary)', marginTop: 2 }}>{value}</div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '10px 12px', fontSize: 11, fontWeight: 600,
  color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em',
};
const tdStyle: React.CSSProperties = { padding: '10px 12px' };

/* ============================================================
   Trace Detail Modal
   ============================================================ */

function TraceDetailModal({ trace, onClose }: { trace: TraceDetail; onClose: () => void }) {
  const t = trace.trace;
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ width: '90%', maxWidth: 800, maxHeight: '85vh', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700 }}>Trace Details</h2>
            <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)', marginTop: 4 }}>{t.id}</p>
          </div>
          <button onClick={onClose} style={{ background: 'var(--surface-hover)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 12px', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)' }}>×</button>
        </div>

        {/* Summary Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginBottom: 16 }}>
          <MiniStat label="Status" value={t.status} color={statusColor(t.status)} />
          <MiniStat label="Model" value={t.selectedModel || '-'} />
          <MiniStat label="Provider" value={t.provider || '-'} />
          <MiniStat label="Mode" value={t.mode || 'standard'} />
          <MiniStat label="Duration" value={fmtMs(t.durationMs)} />
          <MiniStat label="TTFT" value={fmtMs(t.ttftMs)} />
          <MiniStat label="Total Tokens" value={fmt(t.totalTokens)} />
          <MiniStat label="Input" value={fmt(t.inputTokens)} />
          <MiniStat label="Output" value={fmt(t.outputTokens)} />
          <MiniStat label="Credits" value={t.creditsCharged?.toFixed(2) || '-'} />
          <MiniStat label="API Cost" value={t.totalApiCostUsd ? '$' + t.totalApiCostUsd.toFixed(4) : '-'} />
          <MiniStat label="Finish" value={t.finishReason || '-'} />
          <MiniStat label="Credits Before" value={t.creditsBefore?.toFixed(1) || '-'} />
          <MiniStat label="Credits After" value={t.creditsAfter?.toFixed(1) || '-'} />
          <MiniStat label="Requested" value={t.requestedModel || '-'} />
          <MiniStat label="Selection" value={t.selectionReason || '-'} />
        </div>

        {/* Events Timeline */}
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, marginTop: 16 }}>Event Timeline</h3>
        <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 16, marginBottom: 16 }}>
          {t.events.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No events recorded</p>}
          {t.events.map((ev: any) => (
            <div key={ev.id} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: eventTypeColor(ev.eventType) + '18', color: eventTypeColor(ev.eventType), fontWeight: 600 }}>{ev.eventType}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ev.status || ''}</span>
                {ev.durationMs != null && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{ev.durationMs}ms</span>}
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>{new Date(ev.timestamp).toLocaleTimeString()}</span>
              </div>
              {ev.payload && (
                <pre style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, background: 'var(--bg)', padding: 6, borderRadius: 6, overflow: 'auto', maxHeight: 100 }}>
                  {JSON.stringify(ev.payload, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>

        {/* Model Calls */}
        {t.modelCalls.length > 0 && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Model Calls</h3>
            {t.modelCalls.map((mc: any) => (
              <div key={mc.id} style={{ background: 'var(--bg)', borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 12 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <span><b>Provider:</b> {mc.provider}</span>
                  <span><b>Model:</b> {mc.selectedModel}</span>
                  <span><b>Status:</b> <span style={{ color: statusColor(mc.status || '') }}>{mc.status}</span></span>
                  <span><b>Duration:</b> {fmtMs(mc.durationMs)}</span>
                  <span><b>Tokens:</b> {fmt(mc.totalTokens)}</span>
                  <span><b>Finish:</b> {mc.finishReason}</span>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Tool Calls */}
        {t.toolCalls.length > 0 && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Tool Calls</h3>
            {t.toolCalls.map((tc: any) => (
              <div key={tc.id} style={{ background: 'var(--bg)', borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 12 }}>
                <span><b>Tool:</b> {tc.toolName}</span>
                <span style={{ marginLeft: 12 }}><b>Status:</b> {tc.status}</span>
                <span style={{ marginLeft: 12 }}><b>Duration:</b> {fmtMs(tc.durationMs)}</span>
              </div>
            ))}
          </>
        )}

        {/* Errors */}
        {t.errors.length > 0 && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#ef4444' }}>Errors</h3>
            {t.errors.map((err: any) => (
              <div key={err.id} style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.12)', borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 12 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
                  <span><b>Type:</b> {err.errorType}</span>
                  <span><b>Stage:</b> {err.stage}</span>
                  <span><b>Severity:</b> {err.severity}</span>
                  <span><b>Recoverable:</b> {err.recoverable ? 'Yes' : 'No'}</span>
                  <span><b>Resolved:</b> {err.resolved ? 'Yes' : 'No'}</span>
                </div>
                <p style={{ color: 'var(--text-muted)', margin: 0 }}>{err.message}</p>
              </div>
            ))}
          </>
        )}

        {/* Billing */}
        {t.billingTransactions.length > 0 && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Billing Transactions</h3>
            {t.billingTransactions.map((bt: any) => (
              <div key={bt.id} style={{ background: 'var(--bg)', borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 12 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <span><b>Amount:</b> <span style={{ color: bt.amount < 0 ? '#ef4444' : '#22c55e' }}>{bt.amount > 0 ? '+' : ''}{bt.amount.toFixed(2)}</span></span>
                  <span><b>Before:</b> {bt.balanceBefore?.toFixed(1)}</span>
                  <span><b>After:</b> {bt.balanceAfter?.toFixed(1)}</span>
                  <span><b>Reason:</b> {bt.reason}</span>
                  <span><b>Model:</b> {bt.model}</span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Main Component
   ============================================================ */

export default function AdminObservability() {
  const { token } = useAuthStore();

  const [stats, setStats] = useState<Stats | null>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedTrace, setSelectedTrace] = useState<TraceDetail | null>(null);

  /* Filters */
  const [filterStatus, setFilterStatus] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [filterSearch, setFilterSearch] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [statsData, tracesData] = await Promise.all([
        fetchAdmin('/stats', token, { hours: '24' }),
        fetchAdmin('/traces', token, {
          page: String(page), limit: '30',
          status: filterStatus, model: filterModel, search: filterSearch,
        }),
      ]);
      setStats(statsData);
      setTraces(tracesData.traces);
      setTotal(tracesData.total);
    } catch (err) {
      console.error('Load observability error:', err);
    }
    setLoading(false);
  }, [token, page, filterStatus, filterModel, filterSearch]);

  useEffect(() => { load(); }, [load]);

  const openDetail = useCallback(async (traceId: string) => {
    if (!token) return;
    try {
      const data = await fetchAdmin(`/traces/${traceId}`, token);
      setSelectedTrace(data);
    } catch (err) {
      console.error('Load trace detail error:', err);
    }
  }, [token]);

  return (
    <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, fontFamily: 'Sora, sans-serif' }}>Observability</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>AI request monitoring and diagnostics</p>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
          <StatCard label="Requests (24h)" value={fmt(stats.totalRequests)} />
          <StatCard label="Success Rate" value={stats.successRate + '%'} color={stats.successRate >= 99 ? '#22c55e' : stats.successRate >= 95 ? '#f59e0b' : '#ef4444'} />
          <StatCard label="Error Rate" value={stats.errorRate + '%'} color={stats.errorRate <= 1 ? '#22c55e' : stats.errorRate <= 5 ? '#f59e0b' : '#ef4444'} />
          <StatCard label="Avg Latency" value={fmtMs(stats.avgLatencyMs)} />
          <StatCard label="Total Tokens" value={fmt(stats.totalTokens)} />
          <StatCard label="Credits Used" value={fmt(Math.round(stats.totalCreditsUsed))} />
          <StatCard label="API Cost" value={'$' + (stats.totalApiCostUsd || 0).toFixed(2)} />
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          placeholder="Search trace ID, request ID..."
          value={filterSearch}
          onChange={(e) => { setFilterSearch(e.target.value); setPage(1); }}
          style={{ flex: 1, minWidth: 200, padding: '8px 12px', fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', outline: 'none' }}
        />
        <select
          value={filterStatus}
          onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
          style={{ padding: '8px 12px', fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)' }}
        >
          <option value="">All Status</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILED">Failed</option>
          <option value="TIMEOUT">Timeout</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="RATE_LIMITED">Rate Limited</option>
        </select>
        <input
          placeholder="Model..."
          value={filterModel}
          onChange={(e) => { setFilterModel(e.target.value); setPage(1); }}
          style={{ width: 160, padding: '8px 12px', fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', outline: 'none' }}
        />
        <button onClick={load} style={{ padding: '8px 16px', fontSize: 12, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Refresh</button>
      </div>

      {/* Traces Table */}
      <div className="glass-card-sm" style={{ overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--surface-hover)', textAlign: 'left' }}>
              <th style={thStyle}>Time</th>
              <th style={thStyle}>Trace ID</th>
              <th style={thStyle}>User</th>
              <th style={thStyle}>Model</th>
              <th style={thStyle}>Tokens</th>
              <th style={thStyle}>Credits</th>
              <th style={thStyle}>Latency</th>
              <th style={thStyle}>TTFT</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</td></tr>
            ) : traces.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No traces found</td></tr>
            ) : traces.map((t) => (
              <tr
                key={t.id}
                onClick={() => openDetail(t.id)}
                style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', transition: 'background 0.15s' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={tdStyle}>{timeAgo(t.createdAt)}</td>
                <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 11 }}>{t.id.substring(0, 16)}...</td>
                <td style={tdStyle}>{t.userId?.substring(0, 10) || '-'}</td>
                <td style={tdStyle}>{t.selectedModel || '-'}</td>
                <td style={tdStyle}>{fmt(t.totalTokens)}</td>
                <td style={tdStyle}>{t.creditsCharged ? t.creditsCharged.toFixed(1) : '-'}</td>
                <td style={tdStyle}>{fmtMs(t.durationMs)}</td>
                <td style={tdStyle}>{fmtMs(t.ttftMs)}</td>
                <td style={tdStyle}>
                  <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600, color: statusColor(t.status), background: statusColor(t.status) + '18' }}>
                    {t.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > 30 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}
            style={{ padding: '6px 12px', fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', opacity: page === 1 ? 0.4 : 1 }}>
            Prev
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 12px' }}>Page {page} of {Math.ceil(total / 30)}</span>
          <button onClick={() => setPage(page + 1)} disabled={page >= Math.ceil(total / 30)}
            style={{ padding: '6px 12px', fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', opacity: page >= Math.ceil(total / 30) ? 0.4 : 1 }}>
            Next
          </button>
        </div>
      )}

      {/* Per-Model Stats */}
      {stats && stats.perModel.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Per-Model Stats (24h)</h2>
          <div className="glass-card-sm" style={{ overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--surface-hover)', textAlign: 'left' }}>
                  <th style={thStyle}>Model</th>
                  <th style={thStyle}>Requests</th>
                  <th style={thStyle}>Tokens</th>
                  <th style={thStyle}>Cost</th>
                  <th style={thStyle}>Avg Latency</th>
                  <th style={thStyle}>Error Rate</th>
                </tr>
              </thead>
              <tbody>
                {stats.perModel.map((m) => (
                  <tr key={m.model} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={tdStyle}>{m.model}</td>
                    <td style={tdStyle}>{m.requests}</td>
                    <td style={tdStyle}>{fmt(m.totalTokens)}</td>
                    <td style={tdStyle}>${m.totalCostUsd.toFixed(4)}</td>
                    <td style={tdStyle}>{fmtMs(m.avgLatencyMs)}</td>
                    <td style={tdStyle}>
                      <span style={{ color: m.errorRate <= 1 ? '#22c55e' : m.errorRate <= 5 ? '#f59e0b' : '#ef4444' }}>
                        {m.errorRate.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Trace Detail Modal */}
      {selectedTrace && <TraceDetailModal trace={selectedTrace} onClose={() => setSelectedTrace(null)} />}
    </div>
  );
}