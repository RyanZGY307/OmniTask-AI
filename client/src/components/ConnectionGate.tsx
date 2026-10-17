'use client';
import { useCallback, useEffect, useState } from 'react';
import { getApiUrl } from '@/lib/api';

/**
 * 连接门禁：进入任何界面之前，必须能连通后端 API 与数据库。
 * 轮询 `${API_URL}/health`（服务端 ping 4 个 Postgres）：
 * - 200 ok:true            → 后端+数据库全通，放行
 * - 404                    → 后端可达但尚无 /api/health 路由（部署滞后/旧构建），
 *                             能拿到 HTTP 响应即证明后端在线，放行
 * - 503 ok:false / 网络错误 → 后端或数据库不可用，显示“连接失败，请稍后重试”，每 5 秒自动重连
 */
export default function ConnectionGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'ok' | 'failed'>('checking');

  const check = useCallback(async () => {
    try {
      const res = await fetch(`${getApiUrl()}/health`, { cache: 'no-store' });
      if (res.status === 404) { setStatus('ok'); return; }
      const body = await res.json().catch(() => null);
      if (res.status === 200 && body?.ok) { setStatus('ok'); return; }
      setStatus('failed');
    } catch {
      setStatus('failed');
    }
  }, []);

  useEffect(() => {
    check();
    const timer = setInterval(check, 5000);
    return () => clearInterval(timer);
  }, [check]);

  if (status === 'ok') return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="text-center max-w-xs px-4">
        {status === 'checking' ? (
          <>
            <div className="w-8 h-8 mx-auto mb-4 border-2 border-accent border-t-transparent rounded-full anim-spin" />
            <p className="text-sm text-muted">正在连接服务…</p>
          </>
        ) : (
          <>
            <div className="w-12 h-12 mx-auto mb-4 rounded-2xl bg-error/10 border border-error/20 flex items-center justify-center text-error text-xl">⚠️</div>
            <p className="text-base font-medium text-primary mb-1">连接失败，请稍后重试</p>
            <p className="text-xs text-muted mb-4">无法连接后端服务或数据库，每 5 秒自动重试中</p>
            <button
              onClick={check}
              className="px-4 py-2 rounded-capsule bg-accent text-on-accent text-sm hover:bg-accent-hover transition-colors anim-press"
            >
              立即重试
            </button>
          </>
        )}
      </div>
    </div>
  );
}
