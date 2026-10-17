// ================================================================
// Alipay / 支付宝 Adapter
// ================================================================
//
// Alipay may show different name formats:
//   - Full name (Chinese): 张光义
//   - Full name (Pinyin): ZHANG GUANGYI
//   - Partial/masked: 张*义, ZHANG ****
//   - Different order: GUANGYI ZHANG
//
// All are stored as identity variants. NONE is hardcoded as canonical.

export interface NormalizedPayment {
  provider: string;
  providerTransactionId?: string;
  providerReference?: string;
  providerAccountId?: string;
  orderId?: string;
  amount: number;
  currency: string;
  payerDisplayName?: string;
  payerPhone?: string;
  payerEmail?: string;
  payerAccountId?: string;
  recipientDisplayName?: string;
  recipientAccountId?: string;
  occurredAt?: Date;
}

export function normalize(raw: any): NormalizedPayment {
  return {
    provider: 'alipay',
    providerTransactionId: raw.transaction_id || raw.trade_no || raw.txn_id || null,
    providerReference: raw.out_trade_no || raw.reference_id || raw.memo || null,
    providerAccountId: raw.payee_account || raw.seller_id || raw.merchant_id || null,
    orderId: raw.out_trade_no || raw.orderId || raw.order_id || null,
    amount: parseFloat(String(raw.amount || raw.total_amount || raw.trans_amount)) || 0,
    currency: raw.currency || raw.trans_currency || 'CNY',
    payerDisplayName: raw.buyer_name || raw.payer_name || raw.sender || null,
    payerPhone: raw.buyer_phone || raw.payer_phone || null,
    payerEmail: raw.buyer_email || raw.payer_email || null,
    payerAccountId: raw.buyer_id || raw.buyer_user_id || null,
    recipientDisplayName: raw.seller_name || raw.payee_name || raw.recipient || null,
    recipientAccountId: raw.seller_id || raw.payee_account || null,
    occurredAt: parseAlipayDate(raw.gmt_payment || raw.payment_time || raw.completed_at || raw.date) || null,
  };
}

function parseAlipayDate(dateStr?: string): Date | null {
  if (!dateStr) return null;
  try {
    const normalized = dateStr.replace(' ', 'T');
    const dt = new Date(normalized);
    return isNaN(dt.getTime()) ? null : dt;
  } catch {
    return null;
  }
}

export const PROVIDER_CONFIG = {
  name: 'Alipay / 支付宝',
  code: 'alipay',
  defaultCurrency: 'CNY',
  paymentRail: 'digital_wallet',
  idFields: ['trade_no', 'out_trade_no'],
  requiredFields: ['amount', 'currency'],
};
