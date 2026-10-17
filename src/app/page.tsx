'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { clearAuth, getStoredToken } from '@/lib/auth';
import { apiGet } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';

export default function RootPage() {
  const router = useRouter();
  const { loadUser } = useAuthStore();
  const done = useRef(false);

  useEffect(() => {
    // 自动载入最后一次登录的账号
    loadUser();

    if (!getStoredToken()) {
      if (!done.current) { done.current = true; router.replace('/onboarding'); }
      return;
    }

    // 有 token：先验证仍有效（/auth/me）→ 有效直接进 /chat（并同步刷新用户资料，
    // 避免 localStorage 里的旧 tier/积分与服务器不一致）；失效 → 清本地凭据回登录页。
    apiGet('/auth/me')
      .then((d: any) => {
        if (d?.user) useAuthStore.setState({ user: d.user });
        if (!done.current) { done.current = true; router.replace('/chat'); }
      })
      .catch(() => {
        if (done.current) return; // apiFetch 的 401 分支已跳转
        clearAuth();
        done.current = true;
        router.replace('/onboarding');
      });
  }, [router, loadUser]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" />
    </div>
  );
}
