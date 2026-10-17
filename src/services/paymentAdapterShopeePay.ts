// ================================================================
// ShopeePay Adapter
// ================================================================

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
    provider: 'shopeepay',
    providerTransactionId: raw.transaction_sn || raw.transaction_id || raw.transactionId || raw.txn_id || null,
    providerReference: raw.order_sn || raw.reference_id || raw.reference || null,
    providerAccountId: raw.recipient_account || raw.merchant_id || null,
    orderId: raw.order_id || raw.orderId || raw.order_sn || null,
    amount: parseFloat(String(raw.amount)) || 0,
    currency: raw.currency || 'MYR',
    payerDisplayName: raw.sender || raw.payer_name || raw.buyer_name || null,
    payerPhone: raw.payer_phone || raw.phone || null,
    payerEmail: raw.payer_email || raw.email || null,
    payerAccountId: raw.payer_account || null,
    recipientDisplayName: raw.recipient || raw.merchant_name || null,
    recipientAccountId: raw.recipient_account || raw.merchant_id || null,
    occurredAt: parseDateTime(raw.completed_at || raw.date, raw.time) || null,
  };
}

function parseDateTime(dateStr?: string, timeStr?: string): Date | null {
  if (!dateStr) return null;
  try {
    const dt = new Date(timeStr ? `${dateStr}T${timeStr}` : dateStr);
    return isNaN(dt.getTime()) ? null : dt;
  } catch {
    return null;
  }
}

export const PROVIDER_CONFIG = {
  name: 'ShopeePay',
  code: 'shopeepay',
  defaultCurrency: 'MYR',
  paymentRail: 'ewallet',
  idFields: ['transaction_sn', 'order_sn'],
  requiredFields: ['amount', 'currency'],
};
