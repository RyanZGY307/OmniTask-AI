'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPut } from '@/lib/api';
import { useSettingsStore } from '@/store/settingsStore';
import { useT, defaultCurrencyForRegion } from '@/lib/i18n';
import { LANGUAGES } from '@/app/onboarding/languages';
import { REGIONS } from '@/app/onboarding/regions';

interface Currency {
  code: string;
  name: string;
  nameEn: string;
  symbol: string;
  region: string;
}

// 服务端的货币分组名是中文（美洲/欧洲/亚太/中东），在此映射为本地化键
const CURRENCY_GROUP_KEY: Record<string, string> = {
  '美洲': 'loc.group.americas',
  '欧洲': 'loc.group.europe',
  '亚太': 'loc.group.asiapac',
  '中东': 'loc.group.middleeast',
};

export default function LocalizationPage() {
  const router = useRouter();
  const t = useT();
  const settings = useSettingsStore();
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState('');

  useEffect(() => {
    apiGet('/currency/supported')
      .then((d: any) => setCurrencies(d.currencies || []))
      .catch(() => {});
  }, []);

  const q = query.trim().toLowerCase();
  const languages = useMemo(
    () => LANGUAGES.filter(l =>
      !q || l.englishName.toLowerCase().includes(q) || l.nativeName.toLowerCase().includes(q) || l.code.toLowerCase().includes(q)),
    [q],
  );
  const regions = useMemo(
    () => REGIONS.filter(r =>
      !q || r.name.toLowerCase().includes(q) || r.localName.toLowerCase().includes(q) || r.code.toLowerCase().includes(q)),
    [q],
  );
  const currencyList = useMemo(
    () => currencies.filter(c =>
      !q || c.name.toLowerCase().includes(q) || c.nameEn.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)),
    [q, currencies],
  );
  const currencyGroups = useMemo(() => {
    const groups: Record<string, Currency[]> = {};
    for (const c of currencyList) (groups[c.region] ||= []).push(c);
    return groups;
  }, [currencyList]);

  const selectLanguage = (code: string) => {
    settings.setLanguage(code);
    setSaving('language');
    apiPut('/settings', { language: code }).catch(() => {}).finally(() => setSaving(''));
  };

  const selectRegion = (code: string) => {
    settings.setRegion(code);
    setSaving('region');
    apiPut('/settings', { region: code }).catch(() => {});
    // 货币默认跟随地区；用户手动选过货币后不再覆盖
    if (!settings.currencyCustom) {
      const next = defaultCurrencyForRegion(code);
      const supported = currencies.length === 0 || currencies.some(c => c.code === next);
      const currency = supported ? next : 'USD';
      settings.setCurrency(currency);
      apiPut('/currency/preference', { currency }).catch(() => {}).finally(() => setSaving(''));
    } else {
      setSaving('');
    }
  };

  const selectCurrency = (code: string) => {
    settings.setCurrency(code);
    settings.setCurrencyCustom(true);
    setSaving('currency');
    apiPut('/currency/preference', { currency: code }).catch(() => {}).finally(() => setSaving(''));
  };

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <button onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-primary transition-colors mb-3 anim-press">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          {t('common.back')}
        </button>
        <h1 className="text-2xl font-display font-bold text-primary mb-1 anim-fade-up">{t('loc.title')}</h1>
        <p className="text-sm text-muted mb-5 anim-fade-up">{t('loc.subtitle')}</p>

        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('loc.searchPh')}
          className="w-full bg-surface border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 mb-5 transition-[background-color,border-color,box-shadow,opacity,transform,color]" />

        {/* 界面语言 */}
        <section className="liquid-glass p-5 mb-5 anim-fade-up">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-display font-semibold text-primary">{t('loc.langSection')}</h2>
            <span className="text-xs text-muted">{LANGUAGES.find(l => l.code === settings.language)?.nativeName || settings.language}</span>
          </div>
          <div className="max-h-72 overflow-y-auto space-y-1">
            {languages.map((l, i) => (
              <button key={l.code} onClick={() => selectLanguage(l.code)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-card text-left transition-[background-color,border-color,box-shadow,opacity,transform,color] anim-fade-up ${settings.language === l.code ? 'bg-accent/10 border border-accent/30 text-primary' : 'text-muted hover:bg-surface-hover hover:text-primary'}`}
                style={{ animationDelay: `${Math.min(i, 12) * 0.02}s`, opacity: 0 }}>
                <span className="text-sm flex-1">{l.nativeName}</span>
                <span className="text-xs text-muted">{l.englishName}</span>
                {settings.language === l.code && <span className="text-accent">✓</span>}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted mt-3">{t('loc.languageSavedNote')}</p>
        </section>

        {/* 地区 */}
        <section className="liquid-glass p-5 mb-5 anim-fade-up">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-display font-semibold text-primary">{t('loc.regionSection')}</h2>
            <span className="text-xs text-muted">{REGIONS.find(r => r.code === settings.region)?.name || settings.region}</span>
          </div>
          <div className="max-h-72 overflow-y-auto space-y-1">
            {regions.map((r, i) => (
              <button key={r.code} onClick={() => selectRegion(r.code)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-card text-left transition-[background-color,border-color,box-shadow,opacity,transform,color] anim-fade-up ${settings.region === r.code ? 'bg-accent/10 border border-accent/30 text-primary' : 'text-muted hover:bg-surface-hover hover:text-primary'}`}
                style={{ animationDelay: `${Math.min(i, 12) * 0.02}s`, opacity: 0 }}>
                <span className="text-lg">{r.flag}</span>
                <span className="text-sm flex-1">{r.name}</span>
                <span className="text-xs text-muted">{r.code}</span>
                {settings.region === r.code && <span className="text-accent">✓</span>}
              </button>
            ))}
          </div>
        </section>

        {/* 货币 */}
        <section className="liquid-glass p-5 mb-5 anim-fade-up">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-display font-semibold text-primary">{t('loc.currencySection')}</h2>
            <span className="text-xs text-muted">
              {settings.currency} · {settings.currencyCustom ? t('loc.manualNote') : t('loc.autoNote')}
            </span>
          </div>
          {currencyList.length === 0 && (
            <p className="text-sm text-muted py-4 text-center">{t('common.loading')}</p>
          )}
          {Object.entries(currencyGroups).map(([group, list]) => (
            <div key={group} className="mb-3">
              <div className="px-1 py-1 text-xs text-muted font-medium">{CURRENCY_GROUP_KEY[group] ? t(CURRENCY_GROUP_KEY[group]) : group}</div>
              <div className="space-y-1">
                {list.map((c) => (
                  <button key={c.code} onClick={() => selectCurrency(c.code)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-card text-left transition-[background-color,border-color,box-shadow,opacity,transform,color] ${settings.currency === c.code ? 'bg-accent/10 border border-accent/30 text-primary' : 'text-muted hover:bg-surface-hover hover:text-primary'}`}>
                    <span className="text-sm w-10">{c.symbol}</span>
                    <span className="text-sm flex-1">{c.name} · {c.nameEn}</span>
                    <span className="text-xs text-muted">{c.code}</span>
                    {settings.currency === c.code && <span className="text-accent">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        {saving && <p className="text-center text-xs text-muted">{t('stg.saving')}</p>}
      </div>
    </div>
  );
}
