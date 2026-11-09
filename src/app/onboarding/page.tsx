'use client';
import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { setOnboarded, saveAuth } from '@/lib/auth';
import { apiGet, apiPost, apiPut } from '@/lib/api';
import { LANGUAGES } from './languages';
import { REGIONS } from './regions';
import { useAuthStore } from '@/store/authStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useT, defaultCurrencyForRegion } from '@/lib/i18n';

type Phase = 'entrance' | 'auth' | 'language' | 'region' | 'ready';

function OnboardingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { enter, isLoading, error, clearError } = useAuthStore();
  const settings = useSettingsStore();
  const t = useT();

  // /login and /register deep-link straight into the unified auth phase;
  // SSO handoff deep-links new users into 'language' to finish onboarding.
  const phaseParam = searchParams.get('phase');
  const initialPhase: Phase =
    phaseParam === 'auth' || phaseParam === 'language' || phaseParam === 'region'
      ? (phaseParam as Phase)
      : 'entrance';
  const skipEntrance = initialPhase !== 'entrance';

  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [displaying, setDisplaying] = useState(false);

  // Auth fields
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // SSO (Google / GitHub OAuth + GitHub PAT fallback)
  const [sso, setSso] = useState<{ google: boolean; github: boolean } | null>(null);
  const [showPat, setShowPat] = useState(false);
  const [pat, setPat] = useState('');
  const [ssoBusy, setSsoBusy] = useState('');

  // Language / Region
  const [language, setLanguage] = useState('');
  const [region, setRegion] = useState('');
  const [search, setSearch] = useState('');

  const next = useCallback((p: Phase) => {
    setDisplaying(true);
    setTimeout(() => { setPhase(p); setDisplaying(false); }, 260);
  }, []);

  useEffect(() => {
    if (phase !== 'auth') return;
    apiGet('/auth/oauth/available')
      .then((d: any) => setSso({ google: !!d.google, github: !!d.github }))
      .catch(() => setSso({ google: false, github: false }));
  }, [phase]);

  useEffect(() => {
    if (skipEntrance) return;
    const t = setTimeout(() => next('auth'), 1500);
    return () => clearTimeout(t);
  }, [skipEntrance, next]);

  useEffect(() => {
    if (phase === 'ready') {
      localStorage.setItem('cortex_region', region || settings.region);
      localStorage.setItem('cortex_language', language || settings.language);
      setOnboarded();
      settings.setOnboarded();
      const t = setTimeout(() => router.push('/chat'), 1400);
      return () => clearTimeout(t);
    }
  }, [phase]);

  const filteredLanguages = LANGUAGES.filter(l =>
    l.englishName.toLowerCase().includes(search.toLowerCase()) ||
    l.nativeName.toLowerCase().includes(search.toLowerCase()) ||
    l.code.toLowerCase().includes(search.toLowerCase()));
  const filteredRegions = REGIONS.filter(r =>
    r.name.toLowerCase().includes(search.toLowerCase()) ||
    r.localName.toLowerCase().includes(search.toLowerCase()) ||
    r.code.toLowerCase().includes(search.toLowerCase()));

  // Validation: catch problems before touching the network so the user gets
  // immediate, design-consistent feedback.
  const validationError = (() => {
    if (!email.trim()) return t('onb.errNoEmail');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return t('onb.errBadEmail');
    if (!password) return t('onb.errNoPassword');
    if (password.length < 6) return t('onb.errShortPassword');
    return '';
  })();

  // 已有账号登录时，以服务端保存的语言/地区/货币覆盖本机偏好；
  // 用户手动选过货币（currencyCustom）则不覆盖货币。
  const applyServerPrefs = () => {
    const u = useAuthStore.getState().user as { language?: string; region?: string; currency?: string } | null;
    if (!u) return;
    if (u.language) settings.setLanguage(u.language);
    if (u.region) settings.setRegion(u.region);
    if (u.currency && !useSettingsStore.getState().currencyCustom) settings.setCurrency(u.currency);
  };

  const startOauth = async (provider: 'google' | 'github') => {
    if (ssoBusy) return;
    setSsoBusy(provider);
    setAuthError('');
    try {
      const d: any = await apiPost(`/auth/oauth/${provider}/start`, {});
      window.location.href = d.url;
    } catch (err: any) {
      setSsoBusy('');
      setAuthError(err?.message || t('onb.oauthUnavailable'));
    }
  };

  const githubPatLogin = async () => {
    if (!pat.trim() || ssoBusy) return;
    setSsoBusy('pat');
    setAuthError('');
    try {
      const d: any = await apiPost('/auth/github/token', { token: pat.trim() });
      saveAuth(d.token, d.user);
      useAuthStore.setState({ user: d.user, token: d.token, isLoading: false });
      if (d.created) setPhase('language');
      else { applyServerPrefs(); router.push('/chat'); }
    } catch (err: any) {
      setSsoBusy('');
      setAuthError(err?.message || t('onb.patFailed'));
    }
  };

  const handleEnter = async () => {
    if (validationError || isLoading) return;
    clearError();
    setAuthError('');
    const autoUsername = username.trim() || email.split('@')[0];
    try {
      const { created } = await enter({ username: autoUsername, email: email.trim(), password, region: region || undefined, language: language || undefined });
      // 只有新注册的账号才引导选择语言与地区；已有账号直接进入
      if (created) setPhase('language');
      else { applyServerPrefs(); router.push('/chat'); }
    } catch (err: any) {
      // Server errors (wrong password, username taken, network, 500) all
      // surface here with a message; keep the user on the same card.
      setAuthError(err?.message || t('onb.signInFailed'));
    }
  };

  const handleFinish = () => {
    const finalLanguage = language || settings.language;
    const finalRegion = region || settings.region;
    settings.setRegion(finalRegion);
    settings.setLanguage(finalLanguage);
    localStorage.setItem('cortex_region', finalRegion);
    localStorage.setItem('cortex_language', finalLanguage);
    // 回写服务端（语言/地区）；货币未手动指定时跟随地区默认值
    apiPut('/settings', { language: finalLanguage, region: finalRegion }).catch(() => {});
    if (!useSettingsStore.getState().currencyCustom) {
      const currency = defaultCurrencyForRegion(finalRegion);
      settings.setCurrency(currency);
      apiPut('/currency/preference', { currency }).catch(() => {});
    }
    setPhase('ready');
  };

  return (
    <div className={`onboarding-root ${displaying ? 'phase-exit' : 'phase-visible'}`}>
      {phase === 'entrance' && (
        <div className="onboarding-entrance" aria-hidden={displaying}>
          <div className="entrance-glow" />
          <div className="entrance-brand">
            <div style={{
              width: 64, height: 64, margin: '0 auto 18px', borderRadius: 18,
              background: 'rgba(var(--accent-rgb), 0.12)',
              border: '1px solid rgba(var(--accent-rgb), 0.25)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)', fontFamily: 'var(--font-display, DM Sans, sans-serif)' }}>C</span>
            </div>
            <h1 className="font-display font-bold text-primary" style={{ fontSize: '2.5rem', letterSpacing: '-0.02em', display: 'flex', justifyContent: 'center', gap: 0 }}>
              {'OmniTask'.split('').map((ch, i) => (
                <span key={i} className="core-logo-char" style={{ opacity: 0, animation: `coreCharReveal 0.5s cubic-bezier(0.16,1,0.3,1) ${0.35 + i * 0.07}s both` }}>{ch}</span>
              ))}
            </h1>
            <p className="text-muted anim-fade-up" style={{ fontSize: 14, marginTop: 8, animationDelay: '1.0s' }}>{t('onb.tagline')}</p>
          </div>
        </div>
      )}

      <div className="relative z-10 w-full h-full flex items-center justify-center px-4">
        {/* ============ AUTH ============ */}
        {phase === 'auth' && (
          <div className="w-full max-w-md onboarding-phase anim-scale-in">
              <div className="text-center mb-6">
                <h1 className="text-2xl font-display font-bold text-primary">{t('onb.welcome')}</h1>
                <p className="text-muted text-sm mt-1">{t('onb.welcomeSub')}</p>
              </div>

            <div className="glass-card p-6 space-y-4">
              {(error || authError) && (
                <div className="bg-error/10 border border-error/20 text-error text-sm px-4 py-2.5 rounded-card anim-fade-down">
                  {error || authError}
                </div>
              )}
              <div>
                <label className="block text-sm text-muted mb-1.5">{t('onb.username')}</label>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('onb.usernamePh')} autoComplete="username"
                  className="w-full bg-bg border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 transition-[background-color,border-color,opacity,transform]" />
              </div>
              <div>
                <label className="block text-sm text-muted mb-1.5">{t('onb.email')}</label>
                <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setAuthError(''); }}
                  placeholder="you@domain.com" required autoComplete="email"
                  className="w-full bg-bg border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 transition-[background-color,border-color,opacity,transform]" />
              </div>
              <div>
                <label className="block text-sm text-muted mb-1.5">{t('onb.password')}</label>
                <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setAuthError(''); }}
                  placeholder={t('onb.passwordPh')} required autoComplete="current-password"
                  className="w-full bg-bg border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 transition-[background-color,border-color,opacity,transform]" />
              </div>
              <button onClick={handleEnter} disabled={isLoading || !!validationError}
                className="w-full py-2.5 bg-accent hover:bg-accent-hover text-on-accent font-medium rounded-capsule transition-[background-color,border-color,opacity,transform] disabled:opacity-50 anim-press">
                {isLoading ? t('onb.wait') : t('common.continue')}
              </button>
              <button type="button" onClick={() => router.push('/forgot-password')}
                className="w-full text-center text-xs text-muted hover:text-primary transition-colors">
                {t('onb.forgot')}
              </button>
              {!isLoading && validationError && (email.trim() || password) && (
                <p className="text-center text-xs text-error">{validationError}</p>
              )}

              {(sso?.google || sso?.github) && (
                <>
                  <div className="flex items-center gap-3 text-xs text-muted">
                    <span className="flex-1 border-t border-border" />
                    {t('onb.orContinue')}
                    <span className="flex-1 border-t border-border" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {sso.google && (
                      <button onClick={() => startOauth('google')} disabled={!!ssoBusy}
                        className="w-full py-2.5 bg-bg border border-border text-sm text-primary hover:border-accent/50 rounded-capsule transition-[background-color,border-color,opacity,transform] disabled:opacity-50 anim-press">
                        {ssoBusy === 'google' ? t('onb.redirecting') : 'Google'}
                      </button>
                    )}
                    {sso.github && (
                      <button onClick={() => startOauth('github')} disabled={!!ssoBusy}
                        className="w-full py-2.5 bg-bg border border-border text-sm text-primary hover:border-accent/50 rounded-capsule transition-[background-color,border-color,opacity,transform] disabled:opacity-50 anim-press">
                        {ssoBusy === 'github' ? t('onb.redirecting') : 'GitHub'}
                      </button>
                    )}
                  </div>
                </>
              )}

              <div className="text-xs text-muted space-y-2">
                <button onClick={() => setShowPat((v) => !v)} className="text-muted hover:text-primary transition-[background-color,border-color,opacity,transform]">
                  {showPat ? t('onb.patHide') : t('onb.patToggle')}
                </button>
                {showPat && (
                  <div className="space-y-2">
                    <input type="password" value={pat} onChange={(e) => setPat(e.target.value)}
                      placeholder="ghp_… or github_pat_…" autoComplete="off"
                      className="w-full bg-bg border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 transition-[background-color,border-color,opacity,transform]" />
                    <button onClick={githubPatLogin} disabled={!pat.trim() || !!ssoBusy}
                      className="w-full py-2.5 bg-bg border border-border text-sm text-primary hover:border-accent/50 rounded-capsule transition-[background-color,border-color,opacity,transform] disabled:opacity-50 anim-press">
                      {ssoBusy === 'pat' ? t('onb.wait') : t('onb.patContinue')}
                    </button>
                  </div>
                )}
              </div>

              <p className="text-center text-xs text-muted">{t('onb.accountHint')}</p>
            </div>
          </div>
        )}

        {/* ============ LANGUAGE ============ */}
        {phase === 'language' && (
          <div className="w-full max-w-md onboarding-phase anim-scale-in">
            <div className="glass-card p-6">
              <h2 className="text-xl font-display font-bold text-primary mb-1">{t('onb.chooseLanguage')}</h2>
              <p className="text-muted text-sm mb-4">{t('onb.chooseLanguageHint')}</p>
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('common.search')}
                className="w-full bg-bg border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 mb-3 transition-[background-color,border-color,opacity,transform]" />
              <div className="max-h-60 overflow-y-auto space-y-1">
                {filteredLanguages.map((l, i) => (
                  <button key={l.code} onClick={() => setLanguage(l.code)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-card text-left transition-[background-color,border-color,opacity,transform] anim-fade-up ${language === l.code ? 'bg-accent/10 border border-accent/30 text-primary' : 'text-muted hover:bg-surface-hover hover:text-primary'}`}
                    style={{ animationDelay: `${i * 0.02}s`, opacity: 0 }}>
                    <span className="text-sm flex-1">{l.nativeName}</span>
                    <span className="text-xs text-muted">{l.englishName}</span>
                    {language === l.code && <span className="text-accent">✓</span>}
                  </button>
                ))}
              </div>
              <button onClick={() => { if (language) { setSearch(''); setPhase('region'); } }} disabled={!language}
                className="w-full mt-4 py-2.5 bg-accent hover:bg-accent-hover text-on-accent font-medium rounded-capsule transition-[background-color,border-color,opacity,transform] disabled:opacity-30 disabled:cursor-not-allowed anim-press">{t('common.continue')} →</button>
            </div>
          </div>
        )}

        {/* ============ REGION ============ */}
        {phase === 'region' && (
          <div className="w-full max-w-md onboarding-phase anim-scale-in">
            <div className="glass-card p-6">
              <h2 className="text-xl font-display font-bold text-primary mb-1">{t('onb.chooseRegion')}</h2>
              <p className="text-muted text-sm mb-4">{t('onb.chooseRegionHint')}</p>
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('common.search')}
                className="w-full bg-bg border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 mb-3 transition-[background-color,border-color,opacity,transform]" />
              <div className="max-h-60 overflow-y-auto space-y-1">
                {filteredRegions.map((r, i) => (
                  <button key={r.code} onClick={() => setRegion(r.code)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-card text-left transition-[background-color,border-color,opacity,transform] anim-fade-up ${region === r.code ? 'bg-accent/10 border border-accent/30 text-primary' : 'text-muted hover:bg-surface-hover hover:text-primary'}`}
                    style={{ animationDelay: `${i * 0.02}s`, opacity: 0 }}>
                    <span className="text-lg">{r.flag}</span>
                    <span className="text-sm flex-1">{r.name}</span>
                    <span className="text-xs text-muted">{r.code}</span>
                    {region === r.code && <span className="text-accent">✓</span>}
                  </button>
                ))}
              </div>
              <button onClick={handleFinish} disabled={!region}
                className="w-full mt-4 py-2.5 bg-accent hover:bg-accent-hover text-on-accent font-medium rounded-capsule transition-[background-color,border-color,opacity,transform] disabled:opacity-30 disabled:cursor-not-allowed anim-press">{t('common.continue')} →</button>
            </div>
          </div>
        )}

        {/* ============ READY ============ */}
        {phase === 'ready' && (
          <div className="text-center onboarding-phase anim-scale-in">
            <div className="w-16 h-16 mx-auto rounded-full bg-success/15 border border-success/30 flex items-center justify-center anim-float">
              <span className="text-2xl">✓</span>
            </div>
            <h2 className="text-2xl font-display font-bold text-primary mt-6">{t('onb.allSet')}</h2>
            <p className="text-muted text-sm mt-2">{t('onb.redirectingTo')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" />
      </div>
    }>
      <OnboardingContent />
    </Suspense>
  );
}
