'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Appearance = 'light' | 'dark';

/**
 * 同步 <html> 主题类 + meta theme-color。
 * 深色模式下所有页面的 meta theme-color 必须同步为深色，
 * 否则移动端浏览器 UI / 状态栏在滚动时会露出浅色背景。
 */
export function applyAppearanceClasses(appearance: Appearance) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', appearance === 'dark');
  root.classList.toggle('light', appearance === 'light');
  const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  meta?.setAttribute('content', appearance === 'dark' ? '#0a0a0c' : '#f8f9fc');
}

interface SettingsState {
  appearance: Appearance;
  region: string;
  language: string;
  currency: string;
  // 用户是否手动选过货币；未手选时货币跟随地区默认值自动更新
  currencyCustom: boolean;
  onboarded: boolean;
  setAppearance: (a: Appearance) => void;
  setRegion: (r: string) => void;
  setLanguage: (l: string) => void;
  setCurrency: (c: string) => void;
  setCurrencyCustom: (v: boolean) => void;
  setOnboarded: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      appearance: 'light',
      region: 'US',
      language: 'en',
      currency: 'USD',
      currencyCustom: false,
      onboarded: false,
      setRegion: (region) => set({ region }),
      setLanguage: (language) => set({ language }),
      setCurrency: (currency) => set({ currency }),
      setCurrencyCustom: (currencyCustom) => set({ currencyCustom }),
      setAppearance: (appearance) => {
        set({ appearance });
        applyAppearanceClasses(appearance);
      },
      setOnboarded: () => set({ onboarded: true }),
    }),
    {
      name: 'cortex-settings',
      version: 5,
      // 旧版本持久化过 uiEffects/glass（液态玻璃参数），界面已改为普通 UI，
      // 这些字段整体丢弃；仅保留外观/地区/语言/货币/引导标记。
      migrate: (persisted: unknown, _version: number) => {
        const raw = (typeof persisted === 'object' && persisted !== null && 'state' in persisted
          ? (persisted as { state?: unknown }).state
          : persisted) as Record<string, unknown> | null | undefined;
        const state = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        return {
          appearance: state.appearance === 'dark' ? 'dark' : 'light',
          region: typeof state.region === 'string' ? state.region : 'US',
          language: typeof state.language === 'string' ? state.language : 'en',
          currency: typeof state.currency === 'string' ? state.currency : 'USD',
          currencyCustom: state.currencyCustom === true,
          onboarded: state.onboarded === true,
        };
      },
    }
  )
);
