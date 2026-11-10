'use client';
import { Suspense, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { apiPost } from '@/lib/api';
import { saveAuth } from '@/lib/auth';

function SsoCallbackContent() {
  const { provider } = useParams<{ provider: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<'loading' | 'done' | 'cancelled' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (status !== 'loading') return;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const err = searchParams.get('error');
    const validProvider = provider === 'google' || provider === 'github';

    if (err) {
      setStatus('cancelled');
      setMessage('你已取消登录，可以返回重试。');
      return;
    }
    if (!code || !state || !validProvider) {
      setStatus('error');
      setMessage('登录回调参数不完整。');
      return;
    }

    (async () => {
      try {
        const d: any = await apiPost('/auth/oauth/callback', { provider, code, state });
        saveAuth(d.token, d.user);
        setStatus('done');
        router.replace(d.created ? '/onboarding?phase=language' : '/chat');
      } catch (e: any) {
        setStatus('error');
        setMessage(e?.message || '登录失败，请重试');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        {status === 'loading' && (
          <>
            <div className="w-10 h-10 mx-auto border-2 border-accent border-t-transparent rounded-full anim-spin" />
            <p className="text-muted text-sm mt-4">正在完成登录…</p>
          </>
        )}
        {status === 'done' && (
          <p className="text-sm text-muted">登录成功，正在进入 OmniTask…</p>
        )}
        {(status === 'cancelled' || status === 'error') && (
          <div className="glass-card p-6">
            <p className="text-sm text-primary mb-2">{status === 'cancelled' ? '已取消' : '登录未成功'}</p>
            <p className="text-muted text-xs mb-4">{message}</p>
            <button
              onClick={() => router.push('/onboarding')}
              className="w-full py-2.5 bg-accent hover:bg-accent-hover text-on-accent font-medium rounded-capsule transition-[background-color,border-color,box-shadow,opacity,transform,color] anim-press"
            >
              返回登录
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SsoCallbackPage(_props?: { provider?: string }) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-bg flex items-center justify-center">
          <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full anim-spin" />
        </div>
      }
    >
      <SsoCallbackContent />
    </Suspense>
  );
}

