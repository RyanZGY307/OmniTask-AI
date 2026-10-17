'use client';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useSettingsStore } from '@/store/settingsStore';
import { LANGUAGES } from '@/app/onboarding/languages';
import en from './locales/en';
import zhCN from './locales/zh-CN';
import zhTW from './locales/zh-TW';
import ja from './locales/ja';
import ko from './locales/ko';
import es from './locales/es';
import fr from './locales/fr';
import de from './locales/de';
import it from './locales/it';
import pt from './locales/pt';
import ru from './locales/ru';
import ar from './locales/ar';
import th from './locales/th';
import vi from './locales/vi';
import id from './locales/id';
import ms from './locales/ms';
import hi from './locales/hi';
import tr from './locales/tr';
import pl from './locales/pl';
import nl from './locales/nl';
import sv from './locales/sv';
import da from './locales/da';
import fi from './locales/fi';
import nb from './locales/nb';
import uk from './locales/uk';
import cs from './locales/cs';
import el from './locales/el';
import ro from './locales/ro';
import hu from './locales/hu';
import fil from './locales/fil';
import sw from './locales/sw';
import he from './locales/he';

type Dict = Record<string, string>;

// 语言包为静态模块（构建期打包），切换语言即时生效、无需请求。
// 缺失键回退英文，保证任何语言下都不会出现空串或乱码。
const PACKS: Record<string, Dict> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  ko,
  es,
  fr,
  de,
  it,
  pt,
  ru,
  ar,
  th,
  vi,
  id,
  ms,
  hi,
  tr,
  pl,
  nl,
  sv,
  da,
  fi,
  nb,
  uk,
  cs,
  el,
  ro,
  hu,
  fil,
  sw,
  he,
};

export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

const I18nContext = createContext<TFunc>(() => '');

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useSettingsStore((s) => s.language);

  const t = useMemo<TFunc>(() => {
    const pack = PACKS[language] || {};
    return (key, vars) => interpolate(pack[key] ?? (en as Dict)[key] ?? key, vars);
  }, [language]);

  useEffect(() => {
    const meta = LANGUAGES.find((l) => l.code === language);
    const root = document.documentElement;
    root.lang = meta?.bcp47 || language;
    root.dir = meta?.rtl ? 'rtl' : 'ltr';
  }, [language]);

  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

export function useT(): TFunc {
  return useContext(I18nContext);
}

export { defaultCurrencyForRegion } from './regionCurrency';
