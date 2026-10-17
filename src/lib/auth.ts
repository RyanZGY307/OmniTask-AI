export function saveAuth(token: string, user: any) {
  localStorage.setItem('cortex_token', token);
  localStorage.setItem('cortex_user', JSON.stringify(user));
  localStorage.setItem('cortex_region', user.region || 'CN');
  localStorage.setItem('cortex_language', user.language || 'zh-CN');
}

export function getStoredUser() {
  if (typeof window === 'undefined') return null;
  const data = localStorage.getItem('cortex_user');
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

export function getStoredToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cortex_token');
}

export function clearAuth() {
  localStorage.removeItem('cortex_token');
  localStorage.removeItem('cortex_user');
}

export function isLoggedIn() { return !!getStoredToken(); }

export function getRegion() {
  return typeof window !== 'undefined' ? localStorage.getItem('cortex_region') || 'CN' : 'CN';
}

export function getLanguage() {
  return typeof window !== 'undefined' ? localStorage.getItem('cortex_language') || 'zh-CN' : 'zh-CN';
}

export function isOnboarded() {
  return typeof window !== 'undefined' ? localStorage.getItem('cortex_onboarded') === 'true' : false;
}

export function setOnboarded() {
  localStorage.setItem('cortex_onboarded', 'true');
}