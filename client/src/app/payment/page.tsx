'use client';
import { Suspense, useEffect, useState, useRef } from 'react';
import { useAuthStore } from '@/store/authStore';
import { apiGet, apiPost } from '@/lib/api';
import { CREDIT_PACKS } from '@/lib/models';
import { useRouter, useSearchParams } from 'next/navigation';

type PaymentMethod = 'tng' | 'shopeepay' | 'alipay' | 'paypal';

// 各支付方式的收款二维码图（本地静态资源，按选中方式展示）
const QR_BY_METHOD: Record<PaymentMethod, { src: string; hint: string }> = {
  tng: { src: '/payment-qr/tng.jpg', hint: '打开 TNG eWallet 应用扫描' },
  shopeepay: { src: '/payment-qr/shopeepay.png', hint: '打开 Shopee / ShopeePay 应用扫描' },
  alipay: { src: '/payment-qr/alipay.jpg', hint: '打开支付宝扫描' },
  paypal: { src: '/payment-qr/paypal.png', hint: '打开 PayPal 扫描' },
};

function qrFor(method: string | null | undefined) {
  if (!method) return undefined;
  return QR_BY_METHOD[String(method).toLowerCase() as PaymentMethod];
}

export default function PaymentPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <PaymentContent />
    </Suspense>
  );
}

function PaymentContent() {
  const { user, fetchUser } = useAuthStore();
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod | null>(null);
  const [order, setOrder] = useState<any>(null);
  const [reviewResult, setReviewResult] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'select' | 'pay' | 'upload' | 'result'>('select');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchParams = useSearchParams();

  const plans = [
    { key: 'pro_monthly', name: 'Pro 月付', price: '$9.9', desc: '每月 3000 积分', tier: 'PRO' },
    { key: 'pro_yearly', name: 'Pro 年付', price: '$99', desc: '每月 3000 积分（12 个批次）', tier: 'PRO' },
    ...CREDIT_PACKS.map(p => ({
      key: p.id, name: `${p.credits} 积分`, price: `$${p.price}`, desc: '永久有效', tier: 'PACK',
    })),
  ];

  const methods: { key: PaymentMethod; label: string; icon: string }[] = [
    { key: 'tng', label: 'TNG', icon: '🟢' },
    { key: 'shopeepay', label: 'ShopeePay', icon: '🧡' },
    { key: 'alipay', label: '支付宝', icon: '🔵' },
    { key: 'paypal', label: 'PayPal', icon: '🔷' },
  ];
  const selectedQr = selectedMethod ? qrFor(selectedMethod) : undefined;
  const orderQr = order ? qrFor(order.paymentMethod) : undefined;

  useEffect(() => {
    const urlPlan = searchParams.get('plan');
    if (urlPlan) {
      setSelectedPlan(urlPlan);
    }

    const checkActive = async () => {
      try {
        const data = await apiGet('/payment/orders');
        if (data.order && !['PAID', 'EXPIRED', 'CANCELLED'].includes(data.order.status)) {
          setOrder(data.order);
          setStep('pay');
          return;
        }
      } catch {}
      if (urlPlan) setStep('select');
    };
    checkActive();
  }, []);

  const handleCreateOrder = async () => {
    if (!selectedPlan || !selectedMethod) return;
    setLoading(true);
    try {
      const data = await apiPost('/payment/orders', { plan: selectedPlan, paymentMethod: selectedMethod });
      setOrder(data.order);
      setStep('pay');
    } catch (err: any) {
      alert(err.message || '创建订单失败');
    } finally { setLoading(false); }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !order) return;

    setUploading(true);
    setReviewResult(null);

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1];
        try {
          const data = await apiPost(`/payment/orders/${order.orderId}/proofs`, { imageBase64: base64 });
          setReviewResult(data);
          setOrder(data.order);
          setStep('result');
          if (data.order?.status === 'PAID') fetchUser();
        } catch (err: any) {
          alert(err.message || '审核失败');
        } finally { setUploading(false); }
      };
      reader.readAsDataURL(file);
    } catch {
      setUploading(false);
    }
  };

  const handleCancelOrder = async () => {
    if (!order) return;
    try {
      await apiPost(`/payment/orders/${order.orderId}/cancel`, {});
      setOrder(null);
      setStep('select');
      setReviewResult(null);
    } catch (e: any) {
      setError(e?.message || '取消订单失败，请稍后重试');
    }
  };

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-display font-bold text-primary mb-6 anim-fade-up">
          {step === 'select' ? '选择套餐' : step === 'pay' ? '付款' : step === 'upload' ? '上传证明' : '审核结果'}
        </h1>
        {error && (
          <div className="mb-4 text-sm px-4 py-2.5 rounded-card bg-error/10 border border-error/20 text-error anim-fade-down">
            {error}
            <button onClick={() => setError(null)} className="ml-2 text-xs underline">关闭</button>
          </div>
        )}

        {/* Step 1: Select Plan */}
        {step === 'select' && (
          <div className="space-y-4 anim-fade-up anim-delay-1">
            <div className="grid gap-3">
              {plans.map((plan, i) => (
                <button key={plan.key} onClick={() => setSelectedPlan(plan.key)}
                  className={`text-left p-4 rounded-card liquid-glass transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200 ${selectedPlan === plan.key ? 'border-accent bg-accent/5' : 'hover:border-accent/25'}`}
                  style={{ animationDelay: `${i * 0.04}s`, opacity: 0 }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-primary">{plan.name}</div>
                      <div className="text-xs text-muted">{plan.desc}</div>
                    </div>
                    <div className="text-lg font-display font-bold text-accent">{plan.price}</div>
                  </div>
                </button>
              ))}
            </div>

            {selectedPlan && (
              <div className="anim-fade-up">
                <h2 className="text-sm font-medium text-muted mb-3">选择支付方式</h2>
                <div className="grid grid-cols-2 gap-3">
                  {methods.map(m => (
                    <button key={m.key} onClick={() => setSelectedMethod(m.key)}
                      className={`p-4 rounded-card liquid-glass text-center transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200 ${selectedMethod === m.key ? 'border-accent bg-accent/5' : 'hover:border-accent/25'}`}>
                      <div className="text-2xl mb-1">{m.icon}</div>
                      <div className="text-sm text-primary">{m.label}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selectedQr && (
              <div className="flex flex-col items-center anim-fade-up">
                <img src={selectedQr.src} alt="收款码" className="max-w-[240px] max-h-[36vh] w-auto h-auto rounded-card border border-border" />
                <p className="text-xs text-muted mt-2">{selectedQr.hint}</p>
              </div>
            )}

            {selectedPlan && selectedMethod && (
              <button onClick={handleCreateOrder} disabled={loading}
                className="w-full py-3 bg-accent text-on-accent font-medium rounded-card hover:bg-accent/80 transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200 disabled:opacity-50 anim-fade-up">
                {loading ? '创建中...' : '创建订单'}
              </button>
            )}
          </div>
        )}

        {/* Step 2: Pay */}
        {step === 'pay' && order && (
          <div className="space-y-6 anim-fade-up anim-delay-1">
            <div className="liquid-glass p-6">
              <div className="text-center mb-4">
                <div className="text-3xl font-display font-bold text-accent mb-1">
                  {order.currency} {order.expectedAmount.toFixed(2)}
                </div>
                <div className="text-sm text-muted">{order.plan}</div>
              </div>

              {orderQr && (
                <div className="flex flex-col items-center mb-4">
                  <img src={orderQr.src} alt="收款码" className="max-w-[300px] max-h-[52vh] w-auto h-auto rounded-card border border-border" />
                  <p className="text-xs text-muted mt-2">{orderQr.hint}</p>
                </div>
              )}

              <div className="liquid-glass p-4 mb-4">
                <div className="text-xs text-warning mb-2">⚠️ 重要提醒</div>
                <ul className="text-xs text-muted space-y-1.5">
                  <li>• 付款后 <strong className="text-primary">5 分钟以内</strong> 必须截图并上传证明</li>
                  <li>• 截图 <strong className="text-primary">不能有任何小窗遮挡</strong>（悬浮窗、小窗播放、弹窗等）</li>
                  <li>• 确保金额、收款人、交易号、状态清晰可见</li>
                  <li>• 图片比例不限，不同手机截图均可</li>
                </ul>
              </div>

              <div className="text-xs text-muted text-center">
                订单号: {order.orderId}<br />
                有效至: {new Date(order.expiresAt).toLocaleTimeString('zh-CN')}
              </div>
            </div>

            <button onClick={() => setStep('upload')}
              className="w-full py-3 bg-accent text-on-accent font-medium rounded-card hover:bg-accent/80 transition-[background-color,border-color,box-shadow,opacity,transform,color]">
              我已完成付款，上传证明
            </button>

            <button onClick={handleCancelOrder}
              className="w-full py-2 text-sm text-muted hover:text-error transition-colors">
              取消订单
            </button>
          </div>
        )}

        {/* Step 3: Upload */}
        {step === 'upload' && order && (
          <div className="space-y-6 anim-fade-up anim-delay-1">
            {order.status === 'UNDERPAID' && (
              <div className="liquid-glass p-4 border-warning/20">
                <div className="text-sm text-warning mb-1">金额不足</div>
                <div className="text-xs text-muted">
                  已确认: {order.verifiedTotal} {order.currency} | 还需: {order.remainingAmount} {order.currency}
                </div>
              </div>
            )}

            <div className="liquid-glass p-4">
              <div className="text-xs text-warning mb-2">⚠️ 上传要求</div>
              <ul className="text-xs text-muted space-y-1.5">
                <li>• 付款后 <strong className="text-primary">5 分钟以内</strong> 截图并上传</li>
                <li>• 截图 <strong className="text-primary">不能有任何小窗遮挡</strong></li>
                <li>• 使用支付 App 中的原始交易详情截图</li>
              </ul>
            </div>

            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
              className="w-full py-8 border-2 border-dashed border-border rounded-card hover:border-accent/50 transition-[background-color,border-color,box-shadow,opacity,transform,color] flex flex-col items-center gap-2">
              {uploading ? (
                <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full anim-spin" />
              ) : (
                <>
                  <svg className="w-8 h-8 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <span className="text-sm text-muted">点击上传付款截图</span>
                </>
              )}
            </button>

            <button onClick={handleCancelOrder} className="w-full py-2 text-sm text-muted hover:text-error transition-colors">取消订单</button>
          </div>
        )}

        {/* Step 4: Result */}
        {step === 'result' && (
          <div className="space-y-6 anim-fade-up anim-delay-1">
            {order?.status === 'PAID' ? (
              <div className="liquid-glass p-8 text-center">
                <div className="text-4xl mb-4">✅</div>
                <h2 className="text-xl font-display font-bold text-success mb-2">付款成功</h2>
                <p className="text-sm text-muted">套餐已激活，积分已到账</p>
              </div>
            ) : reviewResult ? (
              <div className="liquid-glass p-6">
                <DecisionCard result={reviewResult} />
                {reviewResult.order?.status !== 'PAID' && (
                  <button onClick={() => setStep('upload')} className="w-full mt-4 py-2 bg-accent text-on-accent rounded-card text-sm">
                    重新上传
                  </button>
                )}
              </div>
            ) : order?.status === 'UNDERPAID' ? (
              <div className="liquid-glass p-6">
                <div className="text-center">
                  <div className="text-4xl mb-3">💰</div>
                  <h2 className="text-lg font-display font-bold text-warning mb-2">需要补款</h2>
                  <p className="text-sm text-muted mb-1">已确认: {order.verifiedTotal} {order.currency}</p>
                  <p className="text-sm text-warning">还需: {order.remainingAmount} {order.currency}</p>
                </div>
                <button onClick={() => setStep('upload')} className="w-full mt-4 py-2 bg-accent text-on-accent rounded-card text-sm">
                  上传补款证明
                </button>
              </div>
            ) : null}

            {order?.status === 'PAID' && (
              <button onClick={() => window.location.href = '/chat'}
                className="w-full py-3 bg-accent text-on-accent font-medium rounded-card hover:bg-accent/80 transition-[background-color,border-color,box-shadow,opacity,transform,color]">
                开始使用
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DecisionCard({ result }: { result: any }) {
  const configs: Record<string, { icon: string; title: string; color: string }> = {
    'PASS':                  { icon: '✅', title: '审核通过', color: 'text-success' },
    'AMOUNT_MISMATCH':       { icon: '💰', title: '金额不符', color: 'text-warning' },
    'INVALID_PROOF':         { icon: '❌', title: '证明无效', color: 'text-error' },
    'SUSPECTED_TAMPERING':   { icon: '🚫', title: '无法验证', color: 'text-error' },
    'DUPLICATE_TRANSACTION': { icon: '🔄', title: '重复交易', color: 'text-error' },
    'PAYMENT_METHOD_MISMATCH': { icon: '⚠️', title: '支付方式不匹配', color: 'text-warning' },
    'RECIPIENT_MISMATCH':    { icon: '⚠️', title: '收款人不匹配', color: 'text-error' },
    'UPLOAD_TOO_LATE':       { icon: '⏰', title: '上传超时', color: 'text-warning' },
    'WINDOW_OBSTRUCTION':    { icon: '🪟', title: '小窗遮挡', color: 'text-warning' },
  };

  const cfg = configs[result.decision] || configs['INVALID_PROOF'];

  return (
    <div className="text-center">
      <div className="text-4xl mb-3">{cfg.icon}</div>
      <h2 className={`text-lg font-display font-bold mb-2 ${cfg.color}`}>{cfg.title}</h2>
      <p className="text-sm text-muted">{result.reason}</p>
      {result.verifiedAmount > 0 && (
        <p className="text-sm text-primary mt-2">已确认: {result.verifiedAmount}</p>
      )}
    </div>
  );
}