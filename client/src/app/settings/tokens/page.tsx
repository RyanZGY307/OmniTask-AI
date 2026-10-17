'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isLoggedIn } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import { apiGet } from '@/lib/api';
import { formatCredits, getEffectiveTier } from '@/lib/models';

export default function TokensPage() {
  const router = useRouter();
  const { user, loadUser, fetchProfile } = useAuthStore();
  const [packs, setPacks] = useState<any[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState(false);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [transactionsError, setTransactionsError] = useState(false);
  const [batches, setBatches] = useState<any[]>([]);
  const [expiringBatches, setExpiringBatches] = useState<any[]>([]);
  const [currency, setCurrency] = useState('USD');

  useEffect(() => {
    loadUser();
    if (!isLoggedIn()) { router.replace('/onboarding'); return; }
    fetchProfile();
    apiGet('/tokens/balance').then(d => setBalance(d.balance)).catch(() => setBalanceError(true));
    apiGet('/tokens/transactions').then(d => setTransactions(d.transactions)).catch(() => setTransactionsError(true));
    apiGet('/tokens/batches').then(d => { setBatches(d.batches); setExpiringBatches(d.expiringBatches || []); }).catch(() => setBalanceError(true));
    apiGet('/settings').then(d => setCurrency(d.currency || 'USD')).catch(() => {});
  }, []);

  // 免费版不展示积分购买，也不再请求积分包目录
  useEffect(() => {
    if (!user || getEffectiveTier(user) === 'STANDARD') return;
    apiGet('/tokens/packs').then(d => setPacks(d.packs)).catch(() => {});
  }, [user?.id, user?.subscriptionTier]);

  if (!user) return <div className="min-h-screen flex items-center justify-center bg-bg"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>;

  // 余额以账户余额为准；批次只是明细，历史积分可能没有批次记录。
  const totalRemaining = balanceError ? null : (balance ?? user.creditBalance ?? null);

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-lg mx-auto px-4 py-6">
        <div className="flex items-center gap-4 mb-6 anim-fade-up">
          <button onClick={() => router.push('/settings')} className="p-2 hover:bg-surface-hover rounded-card transition-colors anim-press">
            <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <h1 className="text-xl font-display font-bold text-primary">积分管理</h1>
        </div>

        <div className="glass-card p-5 mb-6 anim-fade-up anim-delay-1">
          <div className="text-sm text-muted mb-1">当前余额</div>
          <div className="text-3xl font-display font-bold text-accent font-mono">{totalRemaining === null ? (balanceError ? '—' : '…') : formatCredits(totalRemaining)}</div>
          {balanceError && <div className="text-xs text-warning mt-1">余额加载失败，请稍后重试</div>}
       {(user.frozenCredits ?? 0) > 0 && <div className="text-xs text-warning mt-1">冻结：{formatCredits(user.frozenCredits ?? 0)}</div>}
           <div className="text-xs text-muted mt-1">自购积分包永久有效；订阅每月赠送积分 30 天有效，过期自动失效</div>
        </div>

        {expiringBatches.length > 0 && (
          <div className="glass-card p-4 mb-4 border border-warning/20 anim-fade-up">
            <div className="text-sm text-warning mb-2">⚠️ 即将过期的积分</div>
            {expiringBatches.map((b: any) => (
              <div key={b.id} className="flex justify-between text-xs text-muted mb-1">
                <span>{Math.floor(b.remaining)} 积分</span>
                <span>{new Date(b.expiryDate).toLocaleDateString('zh-CN')} 过期</span>
              </div>
            ))}
          </div>
        )}

        {batches.length > 0 && (
          <div className="mb-6 anim-fade-up">
            <h2 className="text-sm text-muted mb-2">积分批次明细（先进先出）</h2>
            <div className="space-y-1">
              {batches.map((b: any, i: number) => {
                const daysLeft = Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                return (
                  <div key={b.id} className="glass-card-sm px-3 py-2 flex items-center justify-between text-xs anim-fade-up" style={{ animationDelay: `${i * 0.03}s`, opacity: 0 }}>
                    <div>
                      <span className="text-primary">{Math.floor(b.remaining)}</span>
                      <span className="text-muted"> / {Math.floor(b.amount)}</span>
                      <span className="text-muted ml-2">({b.source === 'purchase' ? '购买' : b.source === 'subscription' ? '赠送' : '管理员'})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted">{new Date(b.createdAt).toLocaleDateString('zh-CN')}</span>
                      <span className={daysLeft <= 7 ? 'text-warning' : 'text-muted'}>{daysLeft}天后过期</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {user && getEffectiveTier(user) !== 'STANDARD' && (
          <>
            <h2 className="text-lg font-display font-semibold text-primary mb-3 anim-fade-up anim-delay-2">加购积分</h2>
            <div className="space-y-2 mb-8">
              {packs.map((pack, i) => (
                <div key={pack.id} className="glass-card-sm p-4 flex items-center justify-between anim-fade-up anim-hover-scale" style={{ animationDelay: `${0.15 + i * 0.05}s`, opacity: 0 }}>
                  <div>
                    <div className="text-primary font-medium font-mono">{Math.floor(pack.credits)} 积分</div>
                    <div className="text-xs text-muted">永久有效</div>
                  </div>
                  <div className="text-right">
                    <div className="text-accent font-bold">${pack.price}</div>
                    <button onClick={() => router.push(`/settings/payment?type=pack&id=${pack.id}`)}
                      className="text-xs text-accent hover:text-accent-hover mt-1">购买 →</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <h2 className="text-lg font-display font-semibold text-primary mb-3 anim-fade-up">消耗记录</h2>
        <div className="space-y-1">
          {transactionsError ? (
            <div className="text-center text-warning py-8 text-sm glass-card-sm anim-fade-up">加载失败，请稍后重试</div>
          ) : transactions.length === 0 ? (
            <div className="text-center text-muted py-8 text-sm glass-card-sm anim-fade-up">暂无记录</div>
          ) : transactions.slice(0, 20).map((tx, i) => (
            <div key={tx.id} className="glass-card-sm px-4 py-3 flex items-center justify-between anim-fade-up" style={{ animationDelay: `${i * 0.03}s`, opacity: 0 }}>
              <div>
                <div className="text-sm text-primary">{tx.description || tx.type}</div>
                <div className="text-xs text-muted">{new Date(tx.createdAt).toLocaleString('zh-CN')}</div>
              </div>
              <div className={`font-mono text-sm ${tx.amount > 0 ? 'text-success' : 'text-error'}`}>{tx.amount > 0 ? '+' : ''}{Math.floor(tx.amount)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}