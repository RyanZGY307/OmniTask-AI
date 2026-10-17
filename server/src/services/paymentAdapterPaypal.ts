// ================================================================
// PayPal Adapter
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
  const fullName = raw.first_name && raw.last_name ? `${raw.first_name} ${raw.last_name}` : null;
  return {
    provider: 'paypal',
    providerTransactionId: raw.txn_id || raw.transaction_id || raw.id || null,
    providerReference: raw.item_number || raw.invoice_id || raw.reference_id || null,
    providerAccountId: raw.receiver_email || raw.receiver_id || raw.merchant_id || null,
    orderId: raw.item_number || raw.invoice_id || raw.custom || raw.orderId || null,
    amount: parseFloat(String(raw.amount || raw.mc_gross || raw.gross_amount)) || 0,
    currency: raw.currency || raw.mc_currency || 'USD',
    payerDisplayName: raw.payer_name || fullName || raw.payerDisplayName || null,
    payerPhone: raw.payer_phone || null,
    payerEmail: raw.payer_email || null,
    payerAccountId: raw.payer_id || raw.buyer_id || null,
    recipientDisplayName: raw.receiver_email || null,
    recipientAccountId: raw.receiver_email || raw.receiver_id || null,
    occurredAt: parsePaypalDate(raw.payment_date || raw.completed_at || raw.created_at) || null,
  };
}

function parsePaypalDate(dateStr?: string): Date | null {
  if (!dateStr) return null;
  try {
    const dt = new Date(dateStr);
    return isNaN(dt.getTime()) ? null : dt;
  } catch {
    return null;
  }
}

export const PROVIDER_CONFIG = {
  name: 'PayPal',
  code: 'paypal',
  defaultCurrency: 'USD',
  paymentRail: 'digital_wallet',
  idFields: ['txn_id', 'item_number'],
  requiredFields: ['amount', 'currency', 'txn_id'],
};
