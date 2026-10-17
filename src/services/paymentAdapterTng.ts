// ================================================================
// TNG eWallet Adapter
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
    provider: 'tng',
    providerTransactionId: raw.transaction_id || raw.transactionId || raw.txn_id || null,
    providerReference: raw.reference_id || raw.reference || raw.referenceId || null,
    providerAccountId: raw.recipient_account || raw.recipientAccount || null,
    orderId: raw.order_id || raw.orderId || null,
    amount: parseFloat(String(raw.amount)) || 0,
    currency: raw.currency || 'MYR',
    payerDisplayName: raw.sender || raw.payer_name || null,
    payerPhone: raw.payer_phone || raw.phone || null,
    payerEmail: raw.payer_email || null,
    payerAccountId: raw.payer_account || null,
    recipientDisplayName: raw.recipient || raw.recipient_name || null,
    recipientAccountId: raw.recipient_account || null,
    occurredAt: parseDateTime(raw.date, raw.time) || null,
  };
}

function parseDateTime(dateStr?: string, timeStr?: string): Date | null {
  if (!dateStr) return null;
  try {
    const dt = new Date(`${dateStr}T${timeStr || '00:00:00'}`);
    return isNaN(dt.getTime()) ? null : dt;
  } catch {
    return null;
  }
}

export const PROVIDER_CONFIG = {
  name: 'TNG eWallet',
  code: 'tng',
  defaultCurrency: 'MYR',
  paymentRail: 'ewallet',
  idFields: ['transaction_id', 'reference_id'],
  requiredFields: ['amount', 'currency'],
};
