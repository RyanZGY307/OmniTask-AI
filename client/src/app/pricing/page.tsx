'use client';
import { useState, useEffect, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { apiPost, apiGet } from '@/lib/api';
import { PRICING, CREDIT_PACKS } from '@/lib/models';

type BillingCycle = 'monthly' | 'yearly';

interface TierInfo {
  key: string;
  name: string;
  icon: string;
  monthly: number;
  yearly: number;
  creditGrant: number;
  highlights: string[];
  models: { name: string; available: boolean; highlight?: boolean }[];
  features: { label: string; free: string; pro: string }[];
}

const TIERS: TierInfo[] = [
  {
    key: 'STANDARD',
    name: '免费版',
    icon: '⚡',
    monthly: 0,
    yearly: 0,
    creditGrant: 0,
    highlights: [
      'Agnes 2.5 Flash / 3.0 Flash',
      'Gemini 3.5/3.6/3.7/3.8 Flash',
      '图片生成 无限',
      '视频生成 无限',
      '深度研究',
      '思考模式 无限',
      '音频生成 无限',
      '免费模型 0 积分，无配额限制',
    ],
    models: [
      { name: 'Agnes 2.5 Flash', available: true },
      { name: 'Agnes 3.0 Flash', available: true },
      { name: 'Gemini 3.5 Flash', available: true },
      { name: 'Gemini 3.6 Flash', available: true },
      { name: 'Gemini 3.7 Flash', available: true },
      { name: 'Gemini 3.8 Flash', available: true },
      { name: 'Agnes Image 2.5 Flash', available: true },
      { name: 'Agnes Video 2.5 Flash', available: true },
    ],
    features: [],
  },
  {
    key: 'PRO',
    name: 'Pro',
    icon: '⭐',
    monthly: PRICING.PRO.monthly,
    yearly: PRICING.PRO.yearly,
    creditGrant: PRICING.PRO.creditGrant,
    highlights: [
        '所有免费版功能',
        '全部 14 个 LLM（含旗舰）',
        '每月赠送 3,000 积分（30天有效）',
        '深度研究',
        '视频生成 无限制',
        '思考模式 无限制',
      ],
      models: [
        { name: 'Agnes 2.5 Flash', available: true },
        { name: 'Agnes 3.0 Flash', available: true },
        { name: 'Gemini 3.5 Flash', available: true },
        { name: 'Gemini 3.6 Flash', available: true },
        { name: 'Gemini 3.7 Flash', available: true },
        { name: 'Gemini 3.8 Flash', available: true },
        { name: 'MiMo V2.6 Flash', available: true },
        { name: 'MiMo V2.6 Pro', available: true },
        { name: 'MiMo V2.6 UltraSpeed', available: true, highlight: true },
      { name: 'DeepSeek V4.1 Flash', available: true },
      { name: 'GPT-5.6 Luna', available: true },
      { name: 'GPT-5.6 Terra', available: true, highlight: true },
      { name: 'GPT-5.6 Sol', available: true, highlight: true },
      { name: 'GPT-6 Astra', available: true, highlight: true },
      { name: 'Agnes Image 2.5 Flash', available: true },
      { name: 'Agnes Video 2.5 Flash', available: true },
      ],
     features: [],
  },
];

// Shared comparison rows (Free vs Pro only — the Ultra tier was retired)
const COMPARISON_ROWS = [
  { category: '基础', items: [
    { label: '每月价格', free: '$0', pro: '$9.9' },
    { label: '每年价格', free: '-', pro: '$99' },
    { label: '月赠积分', free: '无需积分', pro: '3,000/月（30天有效）' },
    { label: '深度研究', free: '✅', pro: '✅' },
    { label: '思考模式', free: '无限', pro: '无限' },
    { label: '视频生成', free: '无限制', pro: '无限制' },
    { label: '音频生成', free: '无限制', pro: '无限制' },
    { label: '代码执行', free: '✅', pro: '✅' },
  ]},
  { category: 'AI 模型', items: [
    { label: 'Agnes 2.5 Flash', free: '✅', pro: '✅' },
    { label: 'Agnes 3.0 Flash', free: '✅', pro: '✅' },
    { label: 'Gemini 3.5 Flash', free: '✅', pro: '✅' },
    { label: 'Gemini 3.6 Flash', free: '✅', pro: '✅' },
    { label: 'Gemini 3.7 Flash', free: '✅', pro: '✅' },
    { label: 'Gemini 3.8 Flash', free: '✅', pro: '✅' },
    { label: 'MiMo V2.6 Flash', free: '❌', pro: '✅' },
    { label: 'MiMo V2.6 Pro', free: '❌', pro: '✅' },
    { label: 'MiMo V2.6 UltraSpeed', free: '❌', pro: '✅' },
    { label: 'DeepSeek V4.1 Flash', free: '❌', pro: '✅' },
    { label: 'DeepSeek V4 Pro', free: '❌', pro: '✅' },
    { label: 'GPT-5.6 Luna', free: '❌', pro: '✅' },
    { label: 'GPT-5.6 Terra', free: '❌', pro: '✅' },
    { label: 'GPT-5.6 Sol', free: '❌', pro: '✅' },
    { label: 'GPT-6 Astra', free: '❌', pro: '✅' },
  ]},
];

export default function PricingPage() {
  const router = useRouter();
  const { user, fetchUser } = useAuthStore();
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [activeTab, setActiveTab] = useState(0); // mobile tab
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [purchasingPack, setPurchasingPack] = useState<string | null>(null);
  const [showComparison, setShowComparison] = useState(false);
  const [touchStart, setTouchStart] = useState(0);
  const [touchEnd, setTouchEnd] = useState(0);

  const currentTier = user?.subscriptionTier || 'STANDARD';
  // ULTRA is retired — legacy Ultra accounts behave as PRO.
  const currentTierNum = currentTier === 'PRO' || currentTier === 'ULTRA' ? 1 : 0;

  const handlePurchase = async (tier: string) => {
    if (tier === 'STANDARD') return;
    const plan = `${tier.toLowerCase()}_${cycle}`;
    router.push(`/payment?plan=${plan}`);
  };

  const handlePurchasePack = async (packId: string) => {
    router.push(`/payment?plan=${packId}`);
  };

  // Swipe handling for mobile tabs
  const handleTouchStart = (e: React.TouchEvent) => setTouchStart(e.targetTouches[0].clientX);
  const handleTouchMove = (e: React.TouchEvent) => setTouchEnd(e.targetTouches[0].clientX);
  const handleTouchEnd = () => {
    const diff = touchStart - touchEnd;
    if (Math.abs(diff) < 50) return;
    if (diff > 0 && activeTab < TIERS.length - 1) setActiveTab(activeTab + 1);
    if (diff < 0 && activeTab > 0) setActiveTab(activeTab - 1);
  };

  const savePercent = cycle === 'yearly' ? (tier: TierInfo) => {
    if (tier.monthly === 0) return 0;
    return Math.round((1 - tier.yearly / (tier.monthly * 12)) * 100);
  } : () => 0;

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* Back */}
        <button onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-primary transition-colors mb-2 anim-press">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          返回
        </button>
        {/* Header */}
        <div className="text-center mb-8 anim-fade-up">
          <h1 className="text-3xl font-display font-bold text-primary mb-2">选择适合你的版本</h1>
          <p className="text-sm text-muted">付费版每月赠送积分，无需额外购买</p>
        </div>

        {/* Billing Toggle */}
        <div className="flex justify-center mb-8 anim-fade-up anim-delay-1">
          <div className="liquid-glass inline-flex p-1 rounded-capsule">
            <button
              onClick={() => setCycle('monthly')}
              className={`px-5 py-2 rounded-capsule text-sm font-medium transition-all duration-300 ${
                cycle === 'monthly'
                  ? 'bg-accent text-on-accent shadow-card'
                  : 'text-muted hover:text-primary'
              }`}
              style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}
            >
              月付
            </button>
            <button
              onClick={() => setCycle('yearly')}
              className={`px-5 py-2 rounded-capsule text-sm font-medium transition-all duration-300 relative ${
                cycle === 'yearly'
                  ? 'bg-accent text-on-accent shadow-card'
                  : 'text-muted hover:text-primary'
              }`}
              style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}
            >
              年付
              <span className="absolute -top-2 -right-2 text-[10px] px-1.5 py-0.5 rounded-capsule bg-success/20 text-success whitespace-nowrap">
                省最多21%
              </span>
            </button>
          </div>
        </div>

        {/* ===== Desktop: 2-column (Ultra retired) ===== */}
        <div className="hidden md:grid md:grid-cols-2 gap-4 md:items-center mb-12 anim-fade-up anim-delay-2">
          {TIERS.map((tier, i) => {
            const isCurrent = currentTier === tier.key || (tier.key === 'PRO' && currentTier === 'ULTRA');
            const isBelow = currentTierNum > (tier.key === 'STANDARD' ? 0 : 1);
            const perMonth = cycle === 'yearly' ? (tier.yearly / 12).toFixed(0) : tier.monthly;

            return (
              <div
                key={tier.key}
                className={`relative liquid-glass p-6 flex flex-col transition-all duration-500 ${
                  isCurrent ? 'border-accent ring-1 ring-accent/30' : ''
                } ${isBelow ? 'opacity-50' : ''} ${
                  tier.key === 'PRO' ? 'md:scale-[1.04] md:z-10 md:shadow-lg' : ''
                }`}
                style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
              >
                {/* Popular badge */}
                {tier.key === 'PRO' && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-capsule bg-accent text-on-accent text-xs font-medium shadow-card">
                    最受欢迎
                  </div>
                )}

                {/* Current badge */}
                {isCurrent && (
                  <div className="absolute -top-3 right-4 px-3 py-1 rounded-capsule bg-success/20 text-success text-xs font-medium border border-success/30">
                    当前版本
                  </div>
                )}

                {/* Icon & Name */}
                <div className="text-center mb-4">
                  <div className="text-3xl mb-2">{tier.icon}</div>
                  <h2 className="text-xl font-display font-bold text-primary">{tier.name}</h2>
                </div>

                {/* Price */}
                <div className="text-center mb-6">
                  {tier.monthly === 0 ? (
                    <div className="text-3xl font-display font-bold text-primary">免费</div>
                  ) : (
                    <>
                      <div className="text-3xl font-display font-bold text-primary">
                        ${perMonth}
                        <span className="text-sm font-normal text-muted">/月</span>
                      </div>
                      {cycle === 'yearly' && (
                        <div className="text-xs text-muted mt-1">
                          年付 ${tier.yearly} · 省 ${(tier.monthly * 12 - tier.yearly).toFixed(0)}
                        </div>
                      )}
                    </>
                  )}
                  {tier.creditGrant > 0 && (
                    <div className="text-xs text-accent mt-2">
                      每月赠送 {tier.creditGrant.toLocaleString()} 积分
                    </div>
                  )}
                </div>

                {/* Highlights */}
                <div className="space-y-2 mb-6 flex-1">
                  {tier.highlights.map(h => (
                    <div key={h} className="flex items-start gap-2 text-sm">
                      <span className="text-accent mt-0.5">✓</span>
                      <span className="text-primary/85">{h}</span>
                    </div>
                  ))}
                </div>

                {/* CTA Button */}
                {isCurrent ? (
                  <div className="text-center py-3 rounded-card border border-border text-sm text-muted">
                    当前版本
                  </div>
                ) : isBelow ? (
                  <div className="text-center py-3 rounded-card border border-border text-sm text-muted">
                    已包含
                  </div>
                ) : (
                  <button
                    onClick={() => handlePurchase(tier.key)}
                    className={`w-full py-3 rounded-card font-medium text-sm transition-all duration-300 ${
                      tier.key === 'PRO'
                        ? 'bg-accent text-on-accent hover:bg-accent/80 shadow-card'
                        : 'bg-surface-hover/60 text-primary border border-border hover:bg-surface-hover hover:border-accent/30'
                    }`}
                    style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
                  >
                    {currentTierNum === 0 ? `升级 ${tier.name}` : `切换到 ${tier.name}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* ===== Mobile: Tabbed ===== */}
        <div className="md:hidden mb-12 anim-fade-up anim-delay-2">
          {/* Tab indicators */}
          <div className="flex justify-center gap-2 mb-4">
            {TIERS.map((tier, i) => (
              <button
                key={tier.key}
                onClick={() => setActiveTab(i)}
                className={`px-4 py-1.5 rounded-capsule text-xs font-medium transition-all duration-300 ${
                  activeTab === i
                    ? 'bg-accent text-on-accent'
                    : 'text-muted hover:text-primary'
                }`}
                style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}
              >
                {tier.icon} {tier.name}
              </button>
            ))}
          </div>

          {/* Swipeable card */}
          <div
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {TIERS.map((tier, i) => {
              if (i !== activeTab) return null;
              const isCurrent = currentTier === tier.key || (tier.key === 'PRO' && currentTier === 'ULTRA');
              const isBelow = currentTierNum > (tier.key === 'STANDARD' ? 0 : 1);
              const perMonth = cycle === 'yearly' && tier.monthly > 0
                ? (tier.yearly / 12).toFixed(0)
                : tier.monthly;

              return (
                <div key={tier.key} className="liquid-glass p-6">
                  <div className="text-center mb-4">
                    <div className="text-4xl mb-2">{tier.icon}</div>
                    <h2 className="text-2xl font-display font-bold text-primary">{tier.name}</h2>
                    {isCurrent && (
                      <span className="inline-block mt-1 px-3 py-0.5 rounded-capsule bg-success/20 text-success text-xs">
                        当前版本
                      </span>
                    )}
                  </div>

                  <div className="text-center mb-6">
                    {tier.monthly === 0 ? (
                      <div className="text-4xl font-display font-bold text-primary">免费</div>
                    ) : (
                      <>
                        <div className="text-4xl font-display font-bold text-primary">
                          ${perMonth}
                          <span className="text-base font-normal text-muted">/月</span>
                        </div>
                        {cycle === 'yearly' && (
                          <div className="text-xs text-muted mt-1">
                            年付 ${tier.yearly} · 省 ${(tier.monthly * 12 - tier.yearly).toFixed(0)}
                          </div>
                        )}
                      </>
                    )}
                    {tier.creditGrant > 0 && (
                      <div className="text-sm text-accent mt-2">
                        每月赠送 {tier.creditGrant.toLocaleString()} 积分
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 mb-6">
                    {tier.highlights.map(h => (
                      <div key={h} className="flex items-start gap-2 text-sm">
                        <span className="text-accent mt-0.5">✓</span>
                        <span className="text-primary/85">{h}</span>
                      </div>
                    ))}
                  </div>

                  {/* Models list */}
                  <div className="liquid-glass p-4 mb-6">
                    <div className="text-xs font-medium text-primary mb-3">可用模型</div>
                    <div className="space-y-2">
                      {tier.models.map(m => (
                        <div key={m.name} className="flex items-center justify-between text-xs">
                          <span className={m.available ? (m.highlight ? 'text-accent font-medium' : 'text-primary') : 'text-muted/40'}>
                            {m.name}
                          </span>
                          <span className={m.available ? 'text-success' : 'text-muted/30'}>
                            {m.available ? '✓' : '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {isCurrent ? (
                    <div className="text-center py-3 rounded-card border border-border text-sm text-muted">
                      当前版本
                    </div>
                  ) : isBelow ? (
                    <div className="text-center py-3 rounded-card border border-border text-sm text-muted">
                      已包含
                    </div>
                  ) : (
                    <button
                      onClick={() => handlePurchase(tier.key)}
                      className={`w-full py-3 rounded-card font-medium text-sm transition-all duration-300 ${
                        tier.key === 'PRO'
                          ? 'bg-accent text-on-accent'
                          : 'bg-surface-hover/60 text-primary border border-border'
                      }`}
                    >
                      {currentTierNum === 0 ? `升级 ${tier.name}` : `切换到 ${tier.name}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Swipe hint */}
          <div className="text-center mt-3">
            <span className="text-xs text-muted/50">← 左右滑动切换 →</span>
          </div>
        </div>

        {/* ===== Detailed Comparison Table ===== */}
        <div className="mb-12">
          <button
            onClick={() => setShowComparison(!showComparison)}
            className="w-full flex items-center justify-center gap-2 py-3 text-sm text-muted hover:text-primary transition-colors anim-fade-up anim-delay-3"
          >
            <span>{showComparison ? '收起' : '查看'}详细对比</span>
            <svg
              className={`w-4 h-4 transition-transform duration-300 ${showComparison ? 'rotate-180' : ''}`}
              style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showComparison && (
            <div className="liquid-glass overflow-hidden anim-dropdown">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  {/* Header */}
                  <thead>
                    <tr className="border-b border-border/30">
                      <th className="text-left py-3 px-4 text-muted font-normal w-1/4"></th>
                      <th className="text-center py-3 px-4">
                        <div className="text-lg">⚡</div>
                        <div className="font-display font-bold text-primary">免费</div>
                        <div className="text-xs text-muted">$0</div>
                      </th>
                      <th className="text-center py-3 px-4 bg-accent/5">
                        <div className="text-lg">⭐</div>
                        <div className="font-display font-bold text-accent">Pro</div>
                        <div className="text-xs text-muted">
                          ${cycle === 'monthly' ? '9.9' : (99/12).toFixed(1)}/月
                        </div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARISON_ROWS.map(section => (
                      <Fragment key={section.category}>
                        {/* Section header */}
                        <tr>
                          <td colSpan={3} className="py-2 px-4 text-xs font-medium text-accent bg-accent/5">
                            {section.category}
                          </td>
                        </tr>
                        {section.items.map(row => (
                          <tr key={row.label} className="border-b border-border/10 hover:bg-surface-hover/50 transition-colors">
                            <td className="py-2.5 px-4 text-muted text-xs">{row.label}</td>
                            <td className="py-2.5 px-4 text-center text-xs">
                              <CellValue value={row.free} />
                            </td>
                            <td className="py-2.5 px-4 text-center text-xs bg-accent/3">
                              <CellValue value={row.pro} />
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ===== Credit Packs（免费版不展示积分购买，只留订阅升级） ===== */}
        {currentTierNum === 1 && (
        <div className="anim-fade-up anim-delay-4">
          <div className="text-center mb-6">
            <h2 className="text-xl font-display font-bold text-primary mb-1">额外积分</h2>
            <p className="text-xs text-muted">适用于所有版本 · 积分永久有效</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {CREDIT_PACKS.map((pack, i) => {
              const perCredit = (pack.price / pack.credits * 1000).toFixed(1);
              return (
                <button
                  key={pack.id}
                  onClick={() => handlePurchasePack(pack.id)}
                  disabled={purchasingPack === pack.id}
                  className="liquid-glass p-4 text-center hover:border-accent/30 transition-all duration-300 group anim-fade-up"
                  style={{ animationDelay: `${0.4 + i * 0.05}s`, opacity: 0 }}
                >
                  <div className="text-lg font-display font-bold text-primary group-hover:text-accent transition-colors">
                    {pack.credits.toLocaleString()}
                  </div>
                  <div className="text-xs text-muted mb-2">积分</div>
                  <div className="text-lg font-display font-bold text-accent">${pack.price}</div>
                  <div className="text-[10px] text-muted/60 mt-1">${perCredit}/千积分</div>
                </button>
              );
            })}
          </div>
        </div>
        )}

        {/* ===== FAQ ===== */}
        <div className="mt-12 anim-fade-up anim-delay-5">
          <h2 className="text-xl font-display font-bold text-primary text-center mb-6">常见问题</h2>
          <div className="space-y-3 max-w-2xl mx-auto">
            {[
              {
                q: '积分用完了怎么办？',
                a: '可以购买额外积分包，永久有效。Pro 订阅每月自动赠送 3,000 积分（年付为 12 个每月批次，每个批次 30 天有效）。',
              },
              {
                q: '免费版有什么限制？',
                a: '免费版可使用对话、深度研究、图片、视频、音频生成（全部无限使用），以及 6 个免费 LLM。付费模型（MiMo / DeepSeek / GPT 旗舰）需升级 Pro。',
              },
              {
                q: '可以随时取消订阅吗？',
                a: '可以，取消后在当前付费周期结束前仍可使用。到期后自动降级为免费版。',
              },
              {
                q: '年付可以退款吗？',
                a: '已激活的会员服务不支持退款，请确认后购买。',
              },
              {
                q: '积分会过期吗？',
                a: '自购积分包永久有效；Pro 订阅每月赠送的 3,000 积分有效期为 30 天。',
              },
            ].map((faq, i) => (
              <details key={i} className="liquid-glass group">
                <summary className="flex items-center justify-between px-4 py-3 cursor-pointer text-sm text-primary list-none">
                  {faq.q}
                  <svg className="w-4 h-4 text-muted transition-transform duration-300 group-open:rotate-180" style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </summary>
                <div className="px-4 pb-3 text-xs text-muted leading-relaxed">{faq.a}</div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CellValue({ value }: { value: string }) {
  if (value === '✅') return <span className="text-success">✓</span>;
  if (value === '❌') return <span className="text-muted/30">—</span>;
  return <span className="text-primary">{value}</span>;
}