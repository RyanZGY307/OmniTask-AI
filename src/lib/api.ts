// When NEXT_PUBLIC_API_URL is set (production / self-hosted), use it as the
// absolute base. It must include the "/api" prefix, because every caller
// passes a path WITHOUT it (e.g. apiGet('/auth/me')) and the backend mounts
// all routes under /api/*. When unset (dev / preview), fall back to the
// same-origin "/api" prefix so Next's dev rewrites forward /api/* to the
// local backend — the browser never calls a hard-coded localhost that is
// unreachable from a preview domain.
const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cortex_token');
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 401) {
    // 带会话 token 的调用 401 = 会话过期：清 token 回登录页（phase=auth 直达登录表单，跳过入口动画）。
    // 无 token 的公开认证接口（登录/注册/enter/OAuth 回调 = 凭据被拒）：
    // 把后端真实报错抛给调用方展示，不做硬跳转——否则登录页输错密码会整页刷新、丢失输入。
    if (typeof window !== 'undefined' && token) {
      localStorage.removeItem('cortex_token');
      localStorage.removeItem('cortex_user');
      window.location.href = '/onboarding?phase=auth';
      throw new Error('登录已过期');
    }
    const data = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(data?.error || '登录失败');
  }
  return res;
}

export async function apiGet(path: string) {
  const res = await apiFetch(path);
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || '请求失败'); }
  return res.json();
}

export async function apiPost(path: string, body: any) {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || '请求失败'); }
  return res.json();
}

export async function apiPut(path: string, body?: any) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `API error ${res.status}`); }
  return res.json();
}

export async function apiPatch(path: string, body: any) {
  const res = await apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || '请求失败'); }
  return res.json();
}

export async function apiDelete(path: string) {
  const res = await apiFetch(path, { method: 'DELETE' });
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || '请求失败'); }
  return res.json();
}

export function getApiUrl() { return API_URL; }