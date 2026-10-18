'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiUrl } from '@/lib/api';
import {
  RETRY_POLL_MS,
  STANDBY_POLL_MS,
  getClientId,
  isStandbyEligible,
} from '@/lib/standby';

export type ConnectionState = 'checking' | 'ok' | 'failed';

export interface UseConnectionHealth {
  status: ConnectionState;
  /** 立即探测一次（挂载、恢复可见、联网、手动重试都会走它） */
  check: () => Promise<ConnectionState>;
}

/**
 * 连接健康 + 待命心跳。
 *
 * 与原 ConnectionGate 的差别（需求：前端运行期间保持待命）：
 *   - 已连通后不停止探测，而是转入 20s 待命节奏持续保温；
 *   - 探测带 X-Client-Id，服务端据此把 4 个 Postgres 的保活从 60s 收紧到 15s；
 *   - 标签页隐藏或离线时完全停发心跳（不发请求、不占流量），恢复可见/联网
 *     立即补探一次——"运行状态"以用户看得见为准；
 *   - 未连通时保持 5s 快速重试，连接建立阶段的体验不变。
 */
export function useConnectionHealth(): UseConnectionHealth {
  const [status, setStatus] = useState<ConnectionState>('checking');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const probe = useCallback(async (): Promise<ConnectionState> => {
    try {
      const res = await fetch(`${getApiUrl()}/health`, {
        cache: 'no-store',
        headers: { 'X-Client-Id': getClientId() },
      });
      // 404 = 后端可达但该路由不存在（旧构建），能拿到 HTTP 响应即证明在线
      if (res.status === 404) return 'ok';
      const body = await res.json().catch(() => null);
      if (res.status === 200 && body?.ok) return 'ok';
      return 'failed';
    } catch {
      return 'failed';
    }
  }, []);

  const check = useCallback(async (): Promise<ConnectionState> => {
    const next = await probe();
    setStatus(next);
    return next;
  }, [probe]);

  useEffect(() => {
    let cancelled = false;

    const arm = (ms: number) => {
      if (cancelled) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { void run(); }, ms);
    };

    const run = async () => {
      if (cancelled) return;
      if (!isStandbyEligible()) {
        // 隐藏/离线：不发心跳，只留一个轻量定时器等资格恢复
        arm(STANDBY_POLL_MS);
        return;
      }
      const next = await check();
      arm(next === 'failed' ? RETRY_POLL_MS : STANDBY_POLL_MS);
    };

    // 恢复可见 / 恢复联网 → 立即补探一次，不必等下一个周期
    const wake = () => {
      if (cancelled) return;
      if (!isStandbyEligible()) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      void run();
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') wake(); };
    const onOnline = () => wake();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    // 挂载即探一次（保持原门禁的首屏语义，与可见性无关）
    void run();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [check]);

  return { status, check };
}
