'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '@/store/authStore';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api';

/* ============================================================
   Connection Types
   ============================================================ */

interface Connection {
  id: string;
  providerId: string;
  type: string;
  authMethod: string;
  status: string;
  permissions: string[];
  scopes: string[];
  credentialState: string | null;
  account: string | null;
  owner: string | null;
  repo: string | null;
  createdAt: string;
  provider: { id: string; name: string; status: string; capabilities: { id: string; description: string }[] };
}

interface Policy {
  R0: string; R1: string; R2: string; R3: string; R4: string;
}

interface PendingAction {
  id: string;
  toolId: string;
  action: string;
  riskLevel: string;
  status: string;
  preview: { description?: string; args?: any } | null;
  createdAt: string;
}

interface Device {
  id: string;
  deviceType: string;
  deviceName: string | null;
  status: string;
  lastActiveAt: string;
}

const RISK_LABELS: Record<string, string> = {
  R0: 'R0 只读', R1: 'R1 低风险写入', R2: 'R2 常规写入', R3: 'R3 高风险', R4: 'R4 危险操作',
};

const POLICY_OPTIONS = [
  { value: 'auto', label: '自动执行' },
  { value: 'confirm', label: '需要确认' },
  { value: 'never', label: '始终禁止' },
];

const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e', pending: '#f59e0b', revoked: '#6b7280',
  expired: '#f97316', reauth_required: '#ef4444',
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] || '#6b7280';
  return (
    <span className="text-xs px-2 py-0.5 rounded-capsule" style={{ background: `${color}22`, color }}>
      {status}
    </span>
  );
}

/* ============================================================
   Main Page
   ============================================================ */

export default function ConnectionsPage() {
  const { token } = useAuthStore();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [policy, setPolicy] = useState<Policy>({ R0: 'auto', R1: 'auto', R2: 'confirm', R3: 'confirm', R4: 'never' });
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // connect form state
  const [patToken, setPatToken] = useState('');
  const [repo, setRepo] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [connRes, actionRes, deviceRes] = await Promise.all([
        apiGet('/connections'),
        apiGet('/actions/pending').catch(() => ({ pending: [] })),
        apiGet('/devices').catch(() => ({ devices: [] })),
      ]);
      setConnections(connRes.connections || []);
      if (connRes.policy) setPolicy(connRes.policy);
      setPending((actionRes.pending || []).filter((a: PendingAction) => a.status === 'pending'));
      setDevices(deviceRes.devices || []);
    } catch (err) {
      console.error('Load connections error:', err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const connectGithub = async () => {
    if (!patToken.trim()) { setMessage({ text: '请输入 GitHub Personal Access Token', error: true }); return; }
    setConnecting(true);
    setMessage(null);
    try {
      const body: any = { method: 'api', token: patToken.trim() };
      if (repo.trim()) body.repo = repo.trim();
      await apiPost('/connections/github/connect', body);
      setPatToken('');
      setRepo('');
      setMessage({ text: 'GitHub 连接成功', error: false });
      await load();
    } catch (err: any) {
      setMessage({ text: err.message || '连接失败', error: true });
    } finally {
      setConnecting(false);
    }
  };

  const revoke = async (id: string) => {
    if (!confirm('确定要断开此连接吗？相关凭据将被吊销。')) return;
    try {
      await apiDelete(`/connections/${id}`);
      await load();
    } catch (err: any) {
      setMessage({ text: err.message || '操作失败', error: true });
    }
  };

  const savePolicy = async () => {
    setSaving(true);
    try {
      await apiPut('/connections/policy', { policy });
      setMessage({ text: '权限策略已保存', error: false });
    } catch (err: any) {
      setMessage({ text: err.message || '保存失败', error: true });
    } finally {
      setSaving(false);
    }
  };

  const decide = async (id: string, approve: boolean) => {
    try {
      await apiPost(`/actions/${id}/${approve ? 'approve' : 'reject'}`, {});
      await load();
    } catch (err: any) {
      setMessage({ text: err.message || '操作失败', error: true });
    }
  };

  const revokeDevice = async (id: string) => {
    try {
      await apiPost(`/devices/${id}/revoke`, {});
      await load();
    } catch (err: any) {
      setMessage({ text: err.message || '操作失败', error: true });
    }
  };

  if (loading) return <div className="flex items-center justify-center min-h-screen"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>;

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-display font-bold text-primary mb-6 anim-fade-up">连接与授权</h1>

        {message && (
          <div className={`liquid-glass p-3 mb-4 text-sm rounded-card anim-fade-up ${message.error ? 'text-error' : 'text-accent'}`}>{message.text}</div>
        )}

        {/* Connect GitHub */}
        <section className="liquid-glass p-6 mb-6 anim-fade-up anim-delay-1">
          <h2 className="text-lg font-display font-semibold text-primary mb-2">连接 GitHub</h2>
          <p className="text-xs text-muted mb-4">使用 Personal Access Token 连接。Token 经 AES-256-GCM 加密存储，仅用于你授权的操作。</p>
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-muted mb-1">Access Token</label>
              <input type="password" value={patToken} onChange={e => setPatToken(e.target.value)} placeholder="ghp_xxxx 或 github_pat_xxxx"
                className="w-full bg-bg/50 border border-border/50 rounded-card px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent/50 transition-colors" />
            </div>
            <div>
              <label className="block text-sm text-muted mb-1">默认仓库 owner/repo（可选）</label>
              <input type="text" value={repo} onChange={e => setRepo(e.target.value)} placeholder="octocat/hello-world"
                className="w-full bg-bg/50 border border-border/50 rounded-card px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent/50 transition-colors" />
            </div>
            <button onClick={connectGithub} disabled={connecting} className="w-full py-2.5 bg-accent text-on-accent font-medium rounded-card hover:bg-accent/80 transition-all duration-200 disabled:opacity-50">
              {connecting ? '连接中...' : '连接'}
            </button>
          </div>
        </section>

        {/* Connections List */}
        <section className="liquid-glass p-6 mb-6 anim-fade-up anim-delay-2">
          <h2 className="text-lg font-display font-semibold text-primary mb-4">已连接账号</h2>
          {connections.length === 0 ? (
            <p className="text-sm text-muted">暂无连接。连接 GitHub 后 AI 可在授权范围内读取仓库、创建 Issue 等。</p>
          ) : (
            <div className="space-y-3">
              {connections.map(c => (
                <div key={c.id} className="border border-border/40 rounded-card p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-primary">{c.provider.name}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <button onClick={() => revoke(c.id)} className="text-xs text-muted hover:text-error transition-colors">断开</button>
                  </div>
                  <div className="text-xs text-muted space-y-1">
                    <div>账号：{c.account || '-'}{c.owner ? ` · 仓库 ${c.owner}${c.repo ? `/${c.repo}` : ''}` : ''}</div>
                    <div>认证方式：{c.authMethod === 'oauth' ? 'OAuth' : 'API Token'}</div>
                    <div>权限：{(c.permissions || []).join(', ') || '-'}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Permission Policy */}
        <section className="liquid-glass p-6 mb-6 anim-fade-up anim-delay-3">
          <h2 className="text-lg font-display font-semibold text-primary mb-2">操作权限策略</h2>
          <p className="text-xs text-muted mb-4">按风险等级控制 AI 工具调用。R4 危险操作始终需要人工确认，无法设为自动执行。</p>
          <div className="space-y-3">
            {(['R0', 'R1', 'R2', 'R3', 'R4'] as const).map(level => (
              <div key={level} className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted whitespace-nowrap">{RISK_LABELS[level]}</span>
                <select
                  value={policy[level]}
                  disabled={level === 'R4'}
                  onChange={e => setPolicy({ ...policy, [level]: e.target.value })}
                  className="bg-bg/50 border border-border/50 rounded-card px-3 py-1.5 text-sm text-primary focus:outline-none focus:border-accent/50 transition-colors disabled:opacity-60"
                >
                  {POLICY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            ))}
          </div>
          <button onClick={savePolicy} disabled={saving} className="mt-4 w-full py-2.5 bg-accent text-on-accent font-medium rounded-card hover:bg-accent/80 transition-all duration-200 disabled:opacity-50">
            {saving ? '保存中...' : '保存策略'}
          </button>
        </section>

        {/* Pending Approvals */}
        <section className="liquid-glass p-6 mb-6 anim-fade-up anim-delay-4">
          <h2 className="text-lg font-display font-semibold text-primary mb-4">待确认操作</h2>
          {pending.length === 0 ? (
            <p className="text-sm text-muted">暂无待确认操作。</p>
          ) : (
            <div className="space-y-3">
              {pending.map(a => (
                <div key={a.id} className="border border-border/40 rounded-card p-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-primary">{a.preview?.description || a.toolId}</span>
                    <span className="text-xs px-2 py-0.5 rounded-capsule bg-warning/20 text-warning">{a.riskLevel}</span>
                  </div>
                  <div className="text-xs text-muted mb-3">{new Date(a.createdAt).toLocaleString('zh-CN')}</div>
                  <div className="flex gap-2">
                    <button onClick={() => decide(a.id, true)} className="flex-1 py-1.5 text-sm rounded-card bg-accent/20 text-accent hover:bg-accent/30 transition-colors">批准执行</button>
                    <button onClick={() => decide(a.id, false)} className="flex-1 py-1.5 text-sm rounded-card bg-surface-hover text-muted hover:text-error transition-colors">拒绝</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Devices */}
        <section className="liquid-glass p-6 anim-fade-up anim-delay-5">
          <h2 className="text-lg font-display font-semibold text-primary mb-4">已登录设备</h2>
          {devices.length === 0 ? (
            <p className="text-sm text-muted">暂无其他设备。</p>
          ) : (
            <div className="space-y-3">
              {devices.map(d => (
                <div key={d.id} className="flex items-center justify-between border border-border/40 rounded-card p-4">
                  <div>
                    <div className="text-sm text-primary">{d.deviceName || d.deviceType}</div>
                    <div className="text-xs text-muted">{new Date(d.lastActiveAt).toLocaleString('zh-CN')}</div>
                  </div>
                  <button onClick={() => revokeDevice(d.id)} className="text-xs text-muted hover:text-error transition-colors">下线</button>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="mt-8 text-center text-xs text-muted">
          <a href="/settings" className="hover:text-primary transition-colors">返回设置</a>
        </div>
      </div>
    </div>
  );
}
