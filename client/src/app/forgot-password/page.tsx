'use client';
import { useState } from 'react';
import Link from 'next/link';
import { apiPost } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError('');
    try {
      await apiPost('/auth/forgot-password', { email });
      setSent(true);
    } catch (err: any) {
      setError(err.message || '操作失败');
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8 anim-fade-up">
          <div className="w-12 h-12 mx-auto mb-4 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center">
            <span className="text-xl font-display font-bold text-accent">C</span>
          </div>
          <h1 className="text-xl font-display font-bold text-primary">忘记密码</h1>
        </div>

        {sent ? (
          <div className="liquid-glass p-6 text-center anim-fade-up anim-delay-1">
            <div className="text-3xl mb-3">📧</div>
            <p className="text-sm text-primary mb-2">如果该邮箱已注册，重置链接已发送</p>
            <p className="text-xs text-muted mb-4">请检查您的邮箱（包括垃圾邮件）</p>
            <Link href="/login" className="text-sm text-accent hover:text-accent/80 transition-colors">
              返回登录
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 anim-fade-up anim-delay-1">
            <div className="liquid-glass p-4">
              <p className="text-xs text-muted mb-4">输入您的注册邮箱，我们将发送密码重置链接</p>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="邮箱地址"
                className="w-full bg-bg/50 border border-border/50 rounded-card px-4 py-3 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 transition-colors"
                required
              />
            </div>

            {error && <p className="text-xs text-error text-center">{error}</p>}

            <button type="submit" disabled={loading}
              className="w-full py-3 bg-accent text-on-accent font-medium rounded-card hover:bg-accent/80 transition-all disabled:opacity-50"
              style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}>
              {loading ? '发送中...' : '发送重置链接'}
            </button>

            <Link href="/login" className="block text-center text-sm text-muted hover:text-primary transition-colors">
              返回登录
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}