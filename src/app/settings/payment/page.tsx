'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { isLoggedIn } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import { apiGet, apiPost } from '@/lib/api';
import CurrencySelector from '@/components/CurrencySelector';
import { Suspense } from 'react';

function PaymentContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loadUser, fetchProfile } = useAuthStore();
  const [step, setStep] = useState(0);
  const [selectedTier, setSelectedTier] = useState('');
  const [months, setMonths] = useState(1);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [qrcodes, setQrcodes] = useState<any[]>([]);
  const [currentPayment, setCurrentPayment] = useState<any>(null);
  const [proofText, setProofText] = useState('');
  const [reviewResult, setReviewResult] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedPack, setSelectedPack] = useState<any>(null);
  const [currency, setCurrency] = useState('USD');
  const [prices, setPrices] = useState<any>(null);
  const [packPrices, setPackPrices] = useState<any[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  const [showCurrency, setShowCurrency] = useState(false);
  const [pricePreview, setPricePreview] = useState<any>(null);

  const packId = searchParams.get('id');

  useEffect(() => {
    loadUser();
    if (!isLoggedIn()) { router.replace('/onboarding'); return; }
    fetchProfile();
    loadPrices();
  }, []);

  useEffect(() => {
    if (currency) loadPrices();
  }, [currency]);

  const loadPrices = async () => {
    try {
      const data = await apiGet('/payment/prices');
      setCurrency(data.currency);
      setPrices(data.prices);
      setPackPrices(data.packPrices || []);
      setPaymentMethods(data.paymentMethods || []);
      if (data.paymentMethods?.length === 1) setPaymentMethod(data.paymentMethods[0].method);
      if (packId && data.packPrices) {
        const pack = data.packPrices.find((p: any) => p.id === packId);
        if (pack) { setSelectedPack(pack); setStep(1); }
      }
    } catch {}
  };

  const handleSubmitPayment = async () => {
    setSubmitting(true);
    try {
      const body: any = { paymentMethod };
      if (selectedPack) {
        body.type = 'pack'; body.packId = selectedPack.id; body.packCredits = selectedPack.credits;
      } else {
        body.type = 'subscription'; body.tier = selectedTier; body.months = months;
      }
      const data = await apiPost('/payment/submit', body);
      setCurrentPayment(data);
      setStep(2);
    } catch (err: any) { alert(err.message); }
    finally { setSubmitting(false); }
  };

  const handleUploadProof = async () => {
    if (!proofText.trim()) return;
    setSubmitting(true);
    try {
      const data = await apiPost(`/payment/proof/${currentPayment.payment.id}`, { proofText });
      setReviewResult(data);
      setStep(3);
      if (data.status === 'APPROVED') fetchProfile();
    } catch (err: any) { alert(err.message); }
    finally { setSubmitting(false); }
  };

  const handleCurrencyChange = async (newCurrency: string) => {
    setCurrency(newCurrency);
    setShowCurrency(false);
    await loadPrices();
  };

  const selectedPrice = selectedTier && prices ? prices[selectedTier]?.[months] : null;

  if (!user) return <div className="min-h-screen flex items-center justify-center bg-bg"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>;

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-lg mx-auto px-4 py-6">
        <div className="flex items-center gap-4 mb-6 anim-fade-up">
          <button onClick={() => step > 0 ? setStep(step - 1) : router.back()} className="p-2 hover:bg-surface-hover rounded-card transition-colors anim-press">
            <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <h1 className="text-xl font-display font-bold text-primary">购买</h1>
          <button onClick={() => setShowCurrency(!showCurrency)} className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded-capsule bg-accent/10 text-accent text-xs">
            💱 {currency}
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          </button>
        </div>

        {showCurrency && (
          <div className="glass-card p-4 mb-4 anim-scale-in">
            <div className="text-sm text-muted mb-3">选择你的货币</div>
            <CurrencySelector currentCurrency={currency} onSelect={handleCurrencyChange} showInline />
          </div>
        )}

        {step === 0 && (
          <div className="space-y-3 anim-fade-up anim-delay-1">
            <button onClick={() => { setSelectedTier('PRO'); setStep(1); }} className="w-full glass-card p-5 text-left anim-hover-scale">
              <div className="flex items-center justify-between mb-2">
                <span className="text-lg font-display font-bold text-primary">Pro</span>
                <div className="text-right">
                  <div className="text-accent font-bold">{prices?.PRO?.[1]?.formatted || '...'}</div>
                   <div className="text-xs text-muted">${prices?.PRO?.[1]?.usd || 9.9} USD</div>
                </div>
              </div>
              <div className="text-xs text-muted">3000积分/月 + 全部模型</div>
            </button>
            <div className="text-xs text-center text-muted mt-2">基础价格以 USD 计，汇率仅供参考</div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4 anim-scale-in">
            {!selectedPack && (
              <div>
                <h3 className="text-sm text-muted mb-2">选择时长</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[1, 3, 6, 12].map(m => {
                    const p = prices?.[selectedTier]?.[m];
                    return (
                      <button key={m} onClick={() => setMonths(m)}
                        className={`py-2 rounded-card text-sm font-medium transition-all anim-press ${months === m ? 'bg-accent text-on-accent' : 'glass-card-sm text-muted hover:text-primary'}`}>
                        {m === 12 ? '1年' : `${m}月`}
                        <div className="text-xs mt-0.5">{p?.formatted || '...'}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {selectedPack && (
              <div className="glass-card p-4">
                <div className="text-primary font-medium">{selectedPack.credits} 积分</div>
                <div className="text-accent font-bold">{selectedPack.formatted}</div>
                <div className="text-xs text-muted">${selectedPack.usd} USD</div>
              </div>
            )}

            <div>
              <h3 className="text-sm text-muted mb-2">支付方式</h3>
              <div className="grid grid-cols-2 gap-2">
                {paymentMethods.map(m => (
                  <button key={m.method} onClick={() => setPaymentMethod(m.method)}
                    className={`py-3 rounded-card text-sm font-medium transition-all anim-press ${paymentMethod === m.method ? 'bg-accent/10 border border-accent/30 text-accent' : 'glass-card-sm text-muted hover:text-primary'}`}>
                    {m.label}
                    {m.hasFee && <div className="text-xs text-warning mt-0.5">+{m.feePercent}% 手续费</div>}
                  </button>
                ))}
              </div>
            </div>

            <div className="glass-card p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted">商品价格</span>
                <span className="text-primary">{selectedPrice?.formatted || selectedPack?.formatted || '...'}</span>
              </div>
              {(selectedPrice?.fee > 0 || selectedPack?.fee > 0) && (
                <div className="flex justify-between text-sm">
                  <span className="text-warning">PayPal 手续费 (4.4%)</span>
                  <span className="text-warning">{selectedPrice ? (selectedPrice.fee > 0 ? `${currency === 'USD' ? '$' : ''}${selectedPrice.fee}` : '免费') : (selectedPack?.fee > 0 ? `${selectedPack.fee}` : '免费')}</span>
                </div>
              )}
              <div className="border-t border-border pt-2 flex justify-between">
                <span className="text-sm text-muted">应付金额</span>
                <div className="text-right">
                  <span className="text-xl font-bold text-accent">{selectedPrice?.total ? (currency === 'USD' ? `$${selectedPrice.total}` : selectedPrice.formatted) : selectedPack?.formatted || '...'}</span>
                  <div className="text-xs text-muted">${selectedPrice?.usd || selectedPack?.usd || '...'} USD</div>
                </div>
              </div>
            </div>

            <button onClick={handleSubmitPayment} disabled={!paymentMethod || submitting}
              className="w-full py-3 bg-accent hover:bg-accent-hover text-on-accent font-medium rounded-capsule transition-all disabled:opacity-30 anim-hover-scale">
              {submitting ? '提交中...' : '确认支付'}
            </button>
            <div className="text-xs text-center text-muted">汇率仅供参考，以实际支付时为准</div>
          </div>
        )}

        {step === 2 && currentPayment && (
          <div className="space-y-4 anim-scale-in">
            <div className="glass-card p-5 text-center">
              <h3 className="text-lg font-display font-semibold text-primary mb-2">请支付</h3>
              <div className="text-3xl font-bold text-accent mb-1">{currentPayment.formattedTotal}</div>
              <div className="text-xs text-muted mb-4">${currentPayment.usdAmount} USD · 汇率 {currentPayment.rate?.toFixed(4)}</div>
              {qrcodes.find(q => q.method === paymentMethod)?.imageUrl ? (
                <img src={qrcodes.find(q => q.method === paymentMethod)?.imageUrl} alt={paymentMethod} className="mx-auto max-w-48 rounded-card mb-4" />
              ) : (
                <div className="w-48 h-48 mx-auto bg-surface rounded-card flex items-center justify-center mb-4">
                  <span className="text-muted text-sm">收款码待上传</span>
                </div>
              )}
              <div className="text-xs text-muted">支付方式：{paymentMethod}</div>
            </div>

            <div className="glass-card p-4">
              <p className="text-sm text-muted mb-3">付款后请上传付款证明</p>
              <textarea value={proofText} onChange={(e) => setProofText(e.target.value)}
                placeholder="粘贴付款截图的文字内容、交易号、或截图描述..."
                className="w-full bg-bg border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 h-24 resize-none mb-3 transition-all" />
              <button onClick={handleUploadProof} disabled={!proofText.trim() || submitting}
                className="w-full py-2.5 bg-accent hover:bg-accent-hover text-on-accent font-medium rounded-capsule transition-all disabled:opacity-30 anim-hover-scale">
                {submitting ? 'AI 审核中...' : '提交审核'}
              </button>
            </div>
          </div>
        )}

        {step === 3 && reviewResult && (
          <div className="space-y-4 anim-scale-in">
            <div className={`glass-card p-6 text-center border-2 ${reviewResult.status === 'APPROVED' ? 'border-success/30' : reviewResult.status === 'PARTIAL' ? 'border-warning/30' : 'border-error/30'}`}>
              <div className="text-3xl mb-3">{reviewResult.status === 'APPROVED' ? '✅' : reviewResult.status === 'PARTIAL' ? '⚠️' : '❌'}</div>
              <h3 className="text-lg font-display font-semibold text-primary mb-2">
                {reviewResult.status === 'APPROVED' ? '审核通过' : reviewResult.status === 'PARTIAL' ? '金额不足' : '审核未通过'}
              </h3>
              <p className="text-sm text-muted mb-4">{reviewResult.message}</p>
              {reviewResult.reason && <p className="text-xs text-muted bg-surface p-3 rounded-card">{reviewResult.reason}</p>}
              {reviewResult.status === 'APPROVED' && <button onClick={() => router.push('/settings')} className="mt-4 px-6 py-2 bg-accent text-on-accent rounded-capsule anim-hover-scale">查看会员</button>}
              {reviewResult.status === 'REJECTED' && <button onClick={() => { setStep(2); setReviewResult(null); setProofText(''); }} className="mt-4 px-6 py-2 bg-accent text-on-accent rounded-capsule anim-hover-scale">重新上传</button>}
              {reviewResult.status === 'PARTIAL' && <button onClick={() => { setStep(2); setReviewResult(null); setProofText(''); }} className="mt-4 px-6 py-2 bg-accent text-on-accent rounded-capsule anim-hover-scale">补交证明</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PaymentPage() {
  return <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-bg"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>}><PaymentContent /></Suspense>;
}