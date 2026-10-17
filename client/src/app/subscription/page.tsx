'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { apiGet } from '@/lib/api';
import { MODEL_REGISTRY, formatCredits } from '@/lib/models';

export default function SubscriptionPage() {
  const router = useRouter();
  const { user, fetchUser } = useAuthStore();
  const [creditInfo, setCreditInfo] = useState<any>(null);
  const [activeOrder, setActiveOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUser(); // 同步最新 tier/积分，避免 localStorage 旧值把 Pro 显示成免费版
    const load = async () => {
      try {
        const [credits, orders] = await Promise.all([
          apiGet('/chat/usage').catch(() => null),
          apiGet('/payment/orders').catch(() => null),
        ]);
        setCreditInfo(credits);
        setActiveOrder(orders?.order || null);
      } catch {} finally { setLoading(false); }
    };
    load();
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center min-h-screen"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>;
  }

  const tier = user?.subscriptionTier || 'STANDARD';
  // Ultra was retired; legacy Ultra accounts now resolve to the Pro label.
  const tierLabels: Record<string, string> = { STANDARD: '免费版', PRO: 'Pro', ULTRA: 'Pro' };
  const tierIcons: Record<string, string> = { STANDARD: '⚡', PRO: '⭐', ULTRA: '⭐' };

  const endDate = user?.subscriptionEnd ? new Date(user.subscriptionEnd) : null;
  const daysLeft = endDate ? Math.max(0, Math.ceil((endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : 0;

  const availableModels = Object.entries(MODEL_REGISTRY).filter(([key, info]) => {
    if (info.tier === 'FREE') return true;
    // All non-free models are Pro-tier now (flagship ones were moved down).
    if (tier === 'PRO' || tier === 'ULTRA') return true;
    return false;
  });

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-lg mx-auto px-4 py-6">
        <h1 className="text-2xl font-display font-bold text-primary mb-6 anim-fade-up">我的订阅</h1>

        {/* Current Plan */}
        <section className="liquid-glass p-6 mb-6 anim-fade-up anim-delay-1">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-3xl">{tierIcons[tier]}</span>
            <div>
              <h2 className="text-lg font-display font-bold text-primary">{tierLabels[tier]}</h2>
              {endDate && <p className="text-xs text-muted">到期: {endDate.toLocaleDateString('zh-CN')} ({daysLeft}天)</p>}
              {!endDate && tier === 'STANDARD' && <p className="text-xs text-muted">永久免费</p>}
            </div>
          </div>

          {/* Credits */}
          <div className="liquid-glass p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted">积分余额</span>
              <span className="text-lg font-display font-bold text-accent">{formatCredits(creditInfo?.creditBalance || 0)}</span>
            </div>
            {creditInfo?.frozenCredits > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">冻结积分</span>
                <span className="text-sm text-warning">{formatCredits(creditInfo.frozenCredits)}</span>
              </div>
            )}
          </div>

          {/* Available models */}
          <div className="mb-4">
            <div className="text-sm text-muted mb-2">可用模型 ({availableModels.length})</div>
            <div className="flex flex-wrap gap-1.5">
              {availableModels.map(([key, info]) => (
                <span key={key} className="text-xs px-2 py-1 rounded-capsule bg-surface-hover text-muted">
                  {info.displayName}
                </span>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            {tier === 'STANDARD' && (
              <button onClick={() => router.push('/pricing')}
                className="flex-1 py-2.5 bg-accent text-on-accent text-sm rounded-card hover:bg-accent/80 transition-all">
                升级订阅
              </button>
            )}
            {tier !== 'STANDARD' && (
              <button onClick={() => router.push('/pricing')}
                className="flex-1 py-2.5 liquid-glass liquid-glass-interactive text-sm text-muted hover:text-primary rounded-card transition-all">
                购买积分
              </button>
            )}
          </div>
        </section>

        {/* Active Order */}
        {activeOrder && (
          <section className="liquid-glass p-6 mb-6 anim-fade-up anim-delay-2">
            <h2 className="text-sm font-medium text-primary mb-3">进行中的订单</h2>
            <div className="text-xs text-muted space-y-1">
              <div className="flex justify-between"><span>订单号</span><span className="text-primary font-mono">{activeOrder.orderId}</span></div>
              <div className="flex justify-between"><span>套餐</span><span className="text-primary">{activeOrder.plan}</span></div>
              <div className="flex justify-between"><span>状态</span><span className="text-warning">{activeOrder.status}</span></div>
              {activeOrder.remainingAmount > 0 && (
                <div className="flex justify-between"><span>还需补款</span><span className="text-warning">{activeOrder.remainingAmount} {activeOrder.currency}</span></div>
              )}
            </div>
            <button onClick={() => router.push(`/payment?plan=${activeOrder.plan}`)}
              className="w-full mt-3 py-2 bg-accent/10 text-accent text-xs rounded-card hover:bg-accent/20 transition-colors">
              查看订单
            </button>
          </section>
        )}

        {/* Billing History Placeholder */}
        <section className="liquid-glass p-6 anim-fade-up anim-delay-3">
          <h2 className="text-sm font-medium text-primary mb-3">消费记录</h2>
          {creditInfo?.creditBalance !== undefined ? (
            <div className="text-xs text-muted text-center py-4">
              近期消费记录请查看积分交易详情
            </div>
          ) : (
            <div className="text-xs text-muted text-center py-4">暂无记录</div>
          )}
        </section>
      </div>
    </div>
  );
}