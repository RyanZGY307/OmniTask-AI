'use client';
import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { apiGet } from '@/lib/api';
import AdminObservability from '@/components/AdminObservability';

export default function AdminDashboard() {
  const { user } = useAuthStore();
  const [stats, setStats] = useState<any>(null);
  const [apiKeyStats, setApiKeyStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('dashboard');

  /* Tab switching via sidebar */
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) setTab(detail);
    };
    window.addEventListener('admin-navigate', handler);
    return () => window.removeEventListener('admin-navigate', handler);
  }, []);

  /* Sync hash on load */
  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash) setTab(hash);
  }, []);

  /* Fetch dashboard data */
  useEffect(() => {
    if (tab !== 'dashboard') return;
    const fetchAll = async () => {
      try {
        const [dashboard, apiKeys] = await Promise.all([
          apiGet('/admin/dashboard').catch(() => null),
          apiGet('/admin/api-keys').catch(() => null),
        ]);
        setStats(dashboard);
        setApiKeyStats(apiKeys?.pools || null);
      } catch {} finally { setLoading(false); }
    };
    fetchAll();
  }, [tab]);

  /* ---- Observability Tab ---- */
  if (tab === 'observability') {
    return <AdminObservability />;
  }

  /* ---- Dashboard Tab ---- */
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-display font-bold text-primary anim-fade-up">管理后台</h1>

      {/* Overview Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 anim-fade-up anim-delay-1">
          {[
            { label: '总用户', value: stats.totalUsers ?? 0, color: 'text-accent' },
            { label: '付费用户', value: stats.paidUsers ?? 0, color: 'text-success' },
            { label: '今日消息', value: stats.todayMessages ?? 0, color: 'text-primary' },
            { label: '今日收入', value: `$${(stats.todayRevenue ?? 0).toFixed(2)}`, color: 'text-warning' },
          ].map(card => (
            <div key={card.label} className="liquid-glass p-4">
              <div className="text-xs text-muted mb-1">{card.label}</div>
              <div className={`text-2xl font-display font-bold ${card.color}`}>{card.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Extended Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 anim-fade-up anim-delay-2">
          {[
            { label: 'Pro 用户', value: stats.proUsers ?? 0, color: 'text-accent' },
            { label: 'Ultra 用户', value: stats.ultraUsers ?? 0, color: 'text-warning' },
            { label: '待审核付款', value: stats.pendingPayments ?? 0, color: 'text-error' },
            { label: '活跃对话', value: stats.activeConversations ?? 0, color: 'text-primary' },
          ].map(card => (
            <div key={card.label} className="liquid-glass p-4">
              <div className="text-xs text-muted mb-1">{card.label}</div>
              <div className={`text-lg font-display font-bold ${card.color}`}>{card.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* API Key Pool Status */}
      {apiKeyStats && Object.keys(apiKeyStats).length > 0 && (
        <section className="liquid-glass p-6 anim-fade-up anim-delay-3">
          <h2 className="text-lg font-display font-semibold text-primary mb-4">API Key 状态</h2>
          <div className="space-y-5">
            {Object.entries(apiKeyStats).map(([provider, keys]: [string, any]) => {
              if (!Array.isArray(keys) || keys.length === 0) return null;

              const providerLabels: Record<string, string> = {
                agnes: 'Agnes',
                deepseek: 'DeepSeek',
                openai: 'OpenAI (GPT)',
                google: 'Google (Gemini)',
                xiaomi: 'Xiaomi (MiMo)',
              };

              const totalCalls = keys.reduce((sum: number, k: any) => sum + (k.totalCalls || 0), 0);
              const healthyCount = keys.filter((k: any) => !k.inCooldown).length;

              return (
                <div key={provider}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-primary">
                        {providerLabels[provider] || provider}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded-capsule bg-accent/10 text-accent">
                        {keys.length} key{keys.length > 1 ? 's' : ''}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded-capsule ${healthyCount === keys.length ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                        {healthyCount}/{keys.length} 健康
                      </span>
                    </div>
                    <span className="text-xs text-muted">总调用: {totalCalls}</span>
                  </div>

                  <div className="space-y-1 ml-2">
                    {keys.map((k: any) => (
                      <div
                        key={k.index}
                        className={`flex items-center justify-between text-xs px-3 py-2 rounded-card transition-all duration-200 ${
                          k.inCooldown
                            ? 'bg-error/5 border border-error/10'
                            : k.failCount > 0
                              ? 'bg-warning/5 border border-warning/10'
                              : 'hover:bg-surface-hover border border-transparent'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${
                            k.inCooldown
                              ? 'bg-error animate-pulse'
                              : k.failCount > 0
                                ? 'bg-warning'
                                : 'bg-success'
                          }`} />
                          <span className="text-muted font-mono w-6">#{k.index}</span>
                          <span className="text-muted font-mono">{k.keyPreview}</span>
                          {k.inCooldown ? (
                            <span className="text-error text-xs">
                              冷却中 ({Math.ceil(k.cooldownRemaining / 1000)}s)
                            </span>
                          ) : k.failCount > 0 ? (
                            <span className="text-warning text-xs">
                              失败 {k.failCount}次
                            </span>
                          ) : (
                            <span className="text-success/60 text-xs">正常</span>
                          )}
                        </div>

                        <div className="flex items-center gap-5 text-muted">
                          <span title="总调用" className="flex items-center gap-1">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                            </svg>
                            {k.totalCalls}
                          </span>
                          <span
                            title="错误率"
                            className={`flex items-center gap-1 ${
                              k.errorRate === '0.0%' ? 'text-success' : 'text-warning'
                            }`}
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                            </svg>
                            {k.errorRate}
                          </span>
                          <span title="平均延迟" className="flex items-center gap-1">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            {k.avgLatency}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Quick Actions */}
      <section className="liquid-glass p-6 anim-fade-up anim-delay-4">
        <h2 className="text-lg font-display font-semibold text-primary mb-4">快捷操作</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Observability', icon: '◉', action: () => { setTab('observability'); window.history.replaceState(null, '', '/admin#observability'); } },
            { label: '用户管理', icon: '👥', path: '/admin/users' },
            { label: '知识库', icon: '📚', path: '/admin/knowledge' },
            { label: '付款审核', icon: '💳', path: '/admin/payments' },
            { label: '进化引擎', icon: '🧬', path: '/admin/evolution' },
            { label: '日志系统', icon: '📋', path: '/admin/logs' },
            { label: '反馈管理', icon: '💬', path: '/admin/feedback' },
            { label: 'Skill 管理', icon: '⚡', path: '/admin/skills' },
          ].map(action => (
            action.action ? (
              <button
                key={action.label}
                onClick={action.action}
                className="flex items-center gap-3 p-3 rounded-card liquid-glass liquid-glass-interactive text-sm text-muted hover:text-primary transition-colors"
              >
                <span className="text-lg">{action.icon}</span>
                <span>{action.label}</span>
              </button>
            ) : (
              <a
                key={action.label}
                href={action.path}
                className="flex items-center gap-3 p-3 rounded-card liquid-glass liquid-glass-interactive text-sm text-muted hover:text-primary transition-colors"
              >
                <span className="text-lg">{action.icon}</span>
                <span>{action.label}</span>
              </a>
            )
          ))}
        </div>
      </section>

      {/* System Info */}
      <section className="liquid-glass p-6 anim-fade-up anim-delay-5">
        <h2 className="text-lg font-display font-semibold text-primary mb-4">系统信息</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex justify-between px-3 py-2">
            <span className="text-muted">版本</span>
            <span className="text-primary font-mono">OmniTask v3.8</span>
          </div>
          <div className="flex justify-between px-3 py-2">
            <span className="text-muted">管理员</span>
            <span className="text-primary">{user?.username}</span>
          </div>
          <div className="flex justify-between px-3 py-2">
            <span className="text-muted">角色</span>
            <span className="text-accent">{user?.role}</span>
          </div>
          <div className="flex justify-between px-3 py-2">
            <span className="text-muted">API Key 总数</span>
            <span className="text-primary font-mono">
              {apiKeyStats
                ? Object.values(apiKeyStats).reduce((sum: number, keys: any) => sum + (Array.isArray(keys) ? keys.length : 0), 0)
                : 0}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}