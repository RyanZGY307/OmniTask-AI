'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useT } from '@/lib/i18n';
import { LANGUAGES } from '@/app/onboarding/languages';
import { apiGet, apiPut, apiDelete } from '@/lib/api';

/* ============================================================
   Usage Tab Types & Helpers
   ============================================================ */

interface UsageTrace {
  traceId: string;
  time: string;
  model: string | null;
  mode: string | null;
  totalTokens: number;
  credits: number | null;
  durationMs: number | null;
  status: string;
}

interface UsageTotals {
  totalRequests: number;
  totalTokens: number;
  totalCredits: number;
  successCount: number;
  successRate?: number | null;
  cacheHitRate?: number | null;
}

interface UsageData {
  totals: UsageTotals;
  traces: UsageTrace[];
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// 统一计数格式（BUG-022）：requests 等整数用千分位，避免 K/% 混排
function fmtInt(n: number | null | undefined): string {
  if (n == null) return '-';
  return n.toLocaleString('en-US');
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

/* ============================================================
   Usage Tab Component
   ============================================================ */

function UsageTab() {
  const [data, setData] = useState<UsageData | null>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiGet(`/settings/usage?days=${days}`);
      setData(res);
    } catch (e: any) {
      // 加载失败时用零值数据兑底，保证页面始终可渲染，并展示重试入口
      setData({
        totals: { totalRequests: 0, totalTokens: 0, totalCredits: 0, successCount: 0 },
        traces: [],
      });
      setLoadError(e?.message || '用量数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  if (!data) return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Failed to load usage data</div>;

  return (
    <div>
      {loadError && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--warning)' }}>{loadError}（已显示零值数据）</span>
          <button onClick={load} style={{ fontSize: 12, background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 'calc(var(--radius-card) - 14px)', padding: '4px 10px', cursor: 'pointer' }}>重试</button>
        </div>
      )}
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600 }}>AI Usage</h3>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="ui-select" style={{ padding: '6px 10px', fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'calc(var(--radius-card) - 14px)', color: 'var(--text-primary)' }}>
          <option value={1}>24 hours</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
        </select>
      </div>

      {/* Summary */}
      <div className="anim-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 20 }}>
        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '12px 14px' }}>
          <div className="caps-label">调用次数</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', marginTop: 2 }}>{fmtInt(data.totals.totalRequests)}</div>
        </div>
        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '12px 14px' }}>
          <div className="caps-label">Token 用量</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', marginTop: 2 }}>{fmt(data.totals.totalTokens)}</div>
        </div>
        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '12px 14px' }}>
          <div className="caps-label">缓存命中率</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', marginTop: 2, color: 'var(--accent)' }}>
            {data.totals.cacheHitRate == null ? '—' : `${Math.round(data.totals.cacheHitRate * 100)}%`}
          </div>
        </div>
        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '12px 14px' }}>
          <div className="caps-label">调用成功率</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', marginTop: 2, color: 'var(--success)' }}>
            {data.totals.successRate == null ? '—' : `${Math.round(data.totals.successRate * 100)}%`}
          </div>
        </div>
      </div>

      {/* History */}
      <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Recent Activity</h4>
      <div style={{ background: 'var(--bg)', borderRadius: 10, overflow: 'hidden' }}>
        {data.traces.length === 0 ? (
          <p style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>No activity in this period</p>
        ) : (
          data.traces.map((t) => (
            <div key={t.traceId} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
              {/* 第一行：模型 + 状态（移动端主信息） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ flex: 1, fontWeight: 500, fontSize: 12 }}>{t.model || 'Unknown'}</span>
                {t.mode && t.mode !== 'standard' && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(var(--accent-rgb),0.1)', color: 'var(--accent)' }}>{t.mode}</span>
                )}
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, color: statusColor(t.status), background: statusColor(t.status) + '18', fontWeight: 600 }}>{t.status}</span>
              </div>
              {/* 第二行：时间 + token + 积分 + 耗时（次要信息，小字号弱化） */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                <span>{new Date(t.time).toLocaleDateString()}</span>
                <span>{fmt(t.totalTokens)} tok</span>
                {t.credits != null && <span>{t.credits.toFixed(1)} cr</span>}
                {t.durationMs != null && <span>{fmtMs(t.durationMs)}</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Settings Page
   ============================================================ */

export default function SettingsPage() {
  const router = useRouter();
  const { user, fetchUser } = useAuthStore();
  const settings = useSettingsStore();
  const t = useT();
  const [defaultModel, setDefaultModel] = useState('auto');
  const [defaultMode, setDefaultMode] = useState('standard');
  const [theme, setTheme] = useState('dark');
  const [enableVoice, setEnableVoice] = useState(true);
  const [enableSearch, setEnableSearch] = useState(true);
  const [teacherStyle, setTeacherStyle] = useState('guided');
  const [gender, setGender] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'settings' | 'usage'>('settings');
  const [deletingAccount, setDeletingAccount] = useState(false);

  const deleteAccount = async () => {
    if (deletingAccount) return;
    if (!window.confirm('确定要永久注销账号并删除所有数据吗？')) return;
    setDeletingAccount(true);
    try {
      await apiDelete('/auth/account');
      localStorage.removeItem('cortex_token');
      router.replace('/onboarding');
    } catch {
      setSaveError('注销失败，请检查网络后重试');
    } finally { setDeletingAccount(false); }
  };

  useEffect(() => {
    const load = async () => {
      try {
        const data = await apiGet('/settings');
        const s = data.settings;
        if (s) {
          setDefaultModel(s.defaultModel || 'auto');
          setDefaultMode(s.defaultMode || 'standard');
          setTheme(s.theme || 'dark');
          setEnableVoice(s.enableVoice ?? true);
          setEnableSearch(s.enableSearch ?? true);
          setTeacherStyle(s.teacherStyle || 'guided');
        }
      } catch {} finally { setLoading(false); }
    };
    load();
    fetchUser(); // 补全账号信息（user 未加载时账号信息卡片会空白）
  }, []);

  // user 加载后同步性别偏好
  useEffect(() => { if (user?.gender) setGender(user.gender); }, [user?.gender]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await apiPut('/settings', { defaultModel, defaultMode, theme, enableVoice, enableSearch, teacherStyle });
      await apiPut('/auth/profile', { gender });
      await fetchUser();
    } catch { setSaveError('保存失败，请检查网络后重试'); } finally { setSaving(false); }
  };

  if (loading) return <div className="flex items-center justify-center min-h-screen"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>;

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <button onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-primary transition-colors mb-3 anim-press">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          返回
        </button>
        <h1 className="text-2xl font-display font-bold text-primary mb-6 anim-fade-up">设置</h1>

        {/* Tab Switcher */}
        <div className="flex gap-1 mb-6 anim-fade-up" style={{ background: 'var(--surface)', borderRadius: 10, padding: 3 }}>
          <button
            onClick={() => setActiveTab('settings')}
            className="flex-1 py-2 text-sm rounded-card transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200"
            style={{
              background: activeTab === 'settings' ? 'var(--bg)' : 'transparent',
              color: activeTab === 'settings' ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: activeTab === 'settings' ? 600 : 400,
            }}
          >
            {t('stg.prefs')}
          </button>
          <button
            onClick={() => setActiveTab('usage')}
            className="flex-1 py-2 text-sm rounded-card transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200"
            style={{
              background: activeTab === 'usage' ? 'var(--bg)' : 'transparent',
              color: activeTab === 'usage' ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: activeTab === 'usage' ? 600 : 400,
            }}
          >
            {t('stg.usage')}
          </button>
        </div>

        {activeTab === 'usage' ? (
          <section className="liquid-glass p-6 anim-fade-up">
            <UsageTab />
          </section>
        ) : (
          <>
            {/* Account Info */}
            <section className="liquid-glass p-6 mb-6 anim-fade-up anim-delay-1">
              <h2 className="text-lg font-display font-semibold text-primary mb-4">{t('stg.accountInfo')}</h2>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between"><span className="text-muted">{t('stg.username')}</span><span className="text-primary">{user?.username}</span></div>
                <div className="flex justify-between"><span className="text-muted">{t('stg.email')}</span><span className="text-primary">{user?.email}</span></div>
                <div className="flex justify-between"><span className="text-muted">{t('stg.plan')}</span><span className="text-accent">{user?.subscriptionTier}</span></div>
                {user?.subscriptionEnd && <div className="flex justify-between"><span className="text-muted">{t('stg.expires')}</span><span className="text-primary">{new Date(user.subscriptionEnd).toLocaleDateString(settings.language || 'zh-CN')}</span></div>}
              </div>
            </section>

            {/* Preferences */}
            <section className="liquid-glass p-6 mb-6 anim-fade-up anim-delay-2">
              <h2 className="text-lg font-display font-semibold text-primary mb-4">{t('stg.prefs')}</h2>
              <div className="space-y-4">
                <a href="/settings/localization" className="w-full text-left px-4 py-3 rounded-card liquid-glass liquid-glass-interactive text-sm text-muted hover:text-primary transition-colors flex items-center justify-between">
                  <span className="flex items-center gap-2.5">
                    <svg className="w-4 h-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 21a9 9 0 100-18 9 9 0 000 18zm0 0c1.657 0 3-4.03 3-9s-1.343-9-3-9-3 4.03-3 9 1.343 9 3 9zM3.6 9h16.8M3.6 15h16.8" /></svg>
                    <span>{t('stg.localization')}</span>
                  </span>
                  <span className="text-xs text-muted">{LANGUAGES.find(l => l.code === settings.language)?.nativeName || settings.language} · {settings.region} · {settings.currency}</span>
                </a>
                <a href="/settings/memory" className="w-full text-left px-4 py-3 rounded-card liquid-glass liquid-glass-interactive text-sm text-muted hover:text-primary transition-colors flex items-center justify-between">
                  <span className="flex items-center gap-2.5">
                    <svg className="w-4 h-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3c4.97 0 9 3.13 9 7 0 2.09-1.12 3.97-2.9 5.25V19a1 1 0 01-1.45.9L15 18.5H9l-1.65 1.4A1 1 0 016 19v-3.75C4.12 13.97 3 12.09 3 10c0-3.87 4.03-7 9-7z" /></svg>
                    <span>{t('mem.title')}</span>
                  </span>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                </a>
                <div>
                  <label className="block text-sm text-muted mb-1">{t('stg.defaultMode')}</label>
                  <select value={defaultMode} onChange={e => setDefaultMode(e.target.value)} className="ui-select w-full bg-bg/50 border border-border/50 rounded-card px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent/50 transition-colors">
                    <option value="fast">{t('stg.modeFast')}</option><option value="standard">{t('stg.modeStandard')}</option><option value="think">{t('stg.modeThink')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-muted mb-1">{t('stg.teacherStyle')}</label>
                  <select value={teacherStyle} onChange={e => setTeacherStyle(e.target.value)} className="ui-select w-full bg-bg/50 border border-border/50 rounded-card px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent/50 transition-colors">
                    <option value="guided">{t('stg.teacherGuided')}</option><option value="direct">{t('stg.teacherDirect')}</option><option value="socratic">{t('stg.teacherSocratic')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-muted mb-1">{t('stg.gender')}</label>
                  <select value={gender} onChange={e => setGender(e.target.value)} className="ui-select w-full bg-bg/50 border border-border/50 rounded-card px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent/50 transition-colors">
                    <option value="">{t('stg.genderUnset')}</option><option value="male">{t('stg.genderM')}</option><option value="female">{t('stg.genderF')}</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted">{t('stg.appearance')}</span>
                  <div className="flex gap-1 rounded-full p-1" style={{ background: 'var(--surface-hover)' }}>
                    {(['light', 'dark'] as const).map((a) => (
                      <button key={a} onClick={() => settings.setAppearance(a)}
                        className={`min-h-[44px] min-w-[44px] px-3 py-1 text-xs rounded-full transition-colors duration-150 ${settings.appearance === a ? 'bg-surface text-primary font-medium shadow-sm' : 'text-muted'}`}>
                        {a === 'light' ? t('stg.light') : t('stg.dark')}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted">{t('stg.voice')}</span>
                  <button type="button" role="switch" aria-checked={enableVoice} aria-label={t('stg.voice')} onClick={() => setEnableVoice(!enableVoice)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full" style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}>
                    <span className={`pointer-events-none relative block h-6 w-11 rounded-full transition-colors ${enableVoice ? 'bg-accent/30' : 'bg-surface-hover'}`}><span className="absolute top-0.5 h-5 w-5 rounded-full transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-300 shadow-sm" style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)', left: enableVoice ? '22px' : '2px', background: enableVoice ? 'var(--accent)' : 'var(--text-muted)' }} /></span>
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted">{t('stg.webSearch')}</span>
                  <button type="button" role="switch" aria-checked={enableSearch} aria-label={t('stg.webSearch')} onClick={() => setEnableSearch(!enableSearch)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full" style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}>
                    <span className={`pointer-events-none relative block h-6 w-11 rounded-full transition-colors ${enableSearch ? 'bg-accent/30' : 'bg-surface-hover'}`}><span className="absolute top-0.5 h-5 w-5 rounded-full transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-300 shadow-sm" style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)', left: enableSearch ? '22px' : '2px', background: enableSearch ? 'var(--accent)' : 'var(--text-muted)' }} /></span>
                  </button>
                </div>
              </div>
            </section>

            {/* Account Actions */}
            <section className="liquid-glass p-6 mb-6 anim-fade-up anim-delay-4">
              <h2 className="text-lg font-display font-semibold text-primary mb-4">{t('stg.actions')}</h2>
              <div className="space-y-3">
                <a href="/subscription" className="w-full text-left px-4 py-3 rounded-card liquid-glass liquid-glass-interactive text-sm text-muted hover:text-primary transition-colors flex items-center justify-between">
                  <span>{t('stg.subAndCredits')}</span><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                </a>
                <a href="/settings/connections" className="w-full text-left px-4 py-3 rounded-card liquid-glass liquid-glass-interactive text-sm text-muted hover:text-primary transition-colors flex items-center justify-between">
                  <span>{t('stg.connections')}</span><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                </a>
                <a href="/settings/feedback" className="w-full text-left px-4 py-3 rounded-card liquid-glass liquid-glass-interactive text-sm text-muted hover:text-primary transition-colors flex items-center justify-between">
                  <span>{t('stg.feedback')}</span><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                </a>
                <a href="/settings/tokens" className="w-full text-left px-4 py-3 rounded-card liquid-glass liquid-glass-interactive text-sm text-muted hover:text-primary transition-colors flex items-center justify-between">
                  <span>{t('stg.apiToken')}</span><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                </a>
                <button onClick={deleteAccount} disabled={deletingAccount} className="w-full text-left px-4 py-3 rounded-card liquid-glass liquid-glass-interactive text-sm text-error hover:text-error/80 transition-colors disabled:opacity-50">
                  {deletingAccount ? t('stg.deleting') : t('stg.deleteAccount')}
                </button>
              </div>
            </section>

            {/* Save */}
            {saveError && (
              <div className="mb-3 px-4 py-2.5 rounded-card bg-error/10 border border-error/20 text-error text-xs anim-fade-down">{saveError}</div>
            )}
            <button onClick={handleSave} disabled={saving} className="w-full py-3 bg-accent text-on-accent font-medium rounded-card hover:bg-accent-hover transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200 disabled:opacity-50 anim-fade-up anim-delay-5 anim-hover-scale" style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}>
              {saving ? t('stg.saving') : t('stg.saveSettings')}
            </button>

            <div className="mt-8 text-center text-xs text-muted anim-fade-up anim-delay-5">
              <div className="flex justify-center gap-4 mt-2">
                <a href="/privacy" className="hover:text-primary transition-colors">{t('stg.privacy')}</a>
                <a href="/terms" className="hover:text-primary transition-colors">{t('stg.terms')}</a>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}