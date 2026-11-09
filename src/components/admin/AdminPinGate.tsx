'use client';
import { useState } from 'react';
import { apiPost } from '@/lib/api';

/**
 * 后台管理页的六位密码门禁：
 * 管理员账号通过登录 + role 检查后，进入 /admin 仍需输入部署环境变量
 * ADMIN_ACCESS_PIN 中的六位数密码。校验由服务端
 * POST /api/auth/admin-verify 完成（需管理员 token），本次会话内记住
 * （sessionStorage），刷新页面需重新输入。
 */
export default function AdminPinGate({ onOk }: { onOk: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!/^\d{6}$/.test(pin)) { setError('请输入六位数字密码'); return; }
    setBusy(true); setError('');
    try {
      await apiPost('/auth/admin-verify', { pin });
      sessionStorage.setItem('cortex_admin_pin_ok', '1');
      onOk();
    } catch (e: any) {
      setError(e?.message || '密码错误');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-bg">
      <div className="w-full max-w-xs px-4 text-center">
        <div className="w-12 h-12 mx-auto mb-4 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent text-xl">🔐</div>
        <p className="text-base font-medium text-primary mb-1">后台管理验证</p>
        <p className="text-xs text-muted mb-4">请输入部署环境变量中的六位管理密码</p>
        <input
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          placeholder="••••••"
          className="w-full mb-3 px-4 py-2.5 rounded-capsule bg-surface border border-border text-center text-lg tracking-widest text-primary focus:outline-none focus:border-accent"
        />
        {error && <p className="text-xs text-error mb-3">{error}</p>}
        <button
          onClick={() => void submit()}
          disabled={busy || pin.length !== 6}
          className="w-full px-4 py-2.5 rounded-capsule bg-accent text-on-accent text-sm hover:bg-accent-hover transition-colors anim-press disabled:opacity-50"
        >
          {busy ? '验证中…' : '进入后台管理'}
        </button>
      </div>
    </div>
  );
}
