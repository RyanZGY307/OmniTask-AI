import { create } from 'zustand';
import { saveAuth, clearAuth, getStoredUser, getStoredToken } from '@/lib/auth';
import { apiPost, apiGet } from '@/lib/api';
import { useSettingsStore } from '@/store/settingsStore';

// 已登录用户的服务端偏好（语言/地区/货币）回填到本机设置：
// 新设备登录后界面语言与货币与账号保持一致。
function adoptServerPrefs(user: { language?: string; region?: string; currency?: string } | null | undefined) {
  if (!user) return;
  const s = useSettingsStore.getState();
  if (user.language) s.setLanguage(user.language);
  if (user.region) s.setRegion(user.region);
  if (user.currency && !s.currencyCustom) s.setCurrency(user.currency);
}

interface User {
  id: string;
  email: string;
  username: string;
  avatar?: string;
  gender?: string | null;
  role: string;
  region?: string;
  language?: string;
  currency?: string;
  subscriptionTier: string;
  subscriptionEnd?: string;
  creditBalance?: number;
  frozenCredits?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string, region?: string, language?: string) => Promise<void>;
  enter: (params: { username: string; email: string; password: string; region?: string; language?: string }) => Promise<{ created: boolean }>;
  logout: () => void;
  loadUser: () => void;
  fetchProfile: () => Promise<void>;
  fetchUser: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  isLoading: false,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const data = await apiPost('/auth/login', { email, password });
      saveAuth(data.token, data.user);
      set({ user: data.user, token: data.token, isLoading: false });
    } catch (err: any) {
      set({ error: err.message, isLoading: false });
      throw err;
    }
  },

  register: async (email, username, password, region, language) => {
    set({ isLoading: true, error: null });
    try {
      const data = await apiPost('/auth/register', { email, username, password, region, language });
      saveAuth(data.token, data.user);
      set({ user: data.user, token: data.token, isLoading: false });
    } catch (err: any) {
      set({ error: err.message, isLoading: false });
      throw err;
    }
  },

  enter: async ({ username, email, password, region, language }) => {
    set({ isLoading: true, error: null });
    try {
      const data = await apiPost('/auth/enter', { username, email, password, region, language });
      saveAuth(data.token, data.user);
      set({ user: data.user, token: data.token, isLoading: false });
      // 区分注册与登录：新账号（created）由调用方继续引导选语言/地区
      return { created: data.created === true };
    } catch (err: any) {
      set({ error: err.message, isLoading: false });
      throw err;
    }
  },

  logout: () => {
    clearAuth();
    set({ user: null, token: null });
  },

  loadUser: () => {
    const user = getStoredUser();
    const token = getStoredToken();
    if (user && token) set({ user, token });
  },

  fetchProfile: async () => {
    try {
      const data = await apiGet('/auth/me');
      set({ user: data.user });
      adoptServerPrefs(data.user);
    } catch {}
  },

  fetchUser: async () => {
    try {
      const data = await apiGet('/auth/me');
      set({ user: data.user });
      adoptServerPrefs(data.user);
    } catch {}
  },

  clearError: () => set({ error: null }),
}));