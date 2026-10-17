// ================================================================
// Payment Verification Engine — Deterministic, no AI involved
// ================================================================
//
// Verifies: amount, currency, recipient, idempotency, timestamp, order status.
// All checks are deterministic rules.

import { prisma } from './db';

export interface VerificationInput {
  paymentId: string;
  orderId?: string;
  amount: number;
  currency: string;
  recipientAccountId?: string;
  providerTransactionId?: string;
  occurredAt?: Date;
}

export interface VerificationResult {
  passed: boolean;
  checks: {
    amount: { passed: boolean; expected?: number; received: number; detail: string };
    currency: { passed: boolean; expected?: string; received: string; detail: string };
    recipient: { passed: boolean; detail: string };
    idempotency: { passed: boolean; detail: string };
    orderStatus: { passed: boolean; detail: string };
    timestamp: { passed: boolean; detail: string };
  };
  reason: string;
}

export async function verify(input: VerificationInput): Promise<VerificationResult> {
  const checks: VerificationResult['checks'] = {
    amount: { passed: false, received: input.amount, detail: '' },
    currency: { passed: false, received: input.currency, detail: '' },
    recipient: { passed: false, detail: '' },
    idempotency: { passed: false, detail: '' },
    orderStatus: { passed: false, detail: '' },
    timestamp: { passed: false, detail: '' },
  };

  // ==================== Idempotency Check ====================
  if (input.providerTransactionId) {
    const existing = await prisma.payment.findFirst({
      where: {
        providerTransactionId: input.providerTransactionId,
        status: { in: ['COMPLETED', 'VERIFIED'] },
        id: { not: input.paymentId },
      },
    });
    if (existing) {
      checks.idempotency.passed = false;
      checks.idempotency.detail = `Transaction ${input.providerTransactionId} already completed (payment ${existing.id})`;
      return buildResult(checks, 'Duplicate transaction — already processed');
    }
  }
  checks.idempotency.passed = true;
  checks.idempotency.detail = 'No duplicate found';

  // ==================== Order Status Check ====================
  if (!input.orderId) {
    checks.orderStatus.passed = false;
    checks.orderStatus.detail = 'No order linked';
    return buildResult(checks, 'Cannot verify without linked order');
  }

  const order = await prisma.paymentOrder.findUnique({
    where: { orderId: input.orderId },
  });

  if (!order) {
    checks.orderStatus.passed = false;
    checks.orderStatus.detail = `Order ${input.orderId} not found`;
    return buildResult(checks, 'Order not found');
  }

  if (order.status === 'PAID') {
    checks.orderStatus.passed = false;
    checks.orderStatus.detail = 'Order already paid';
    return buildResult(checks, 'Order already fully paid');
  }

  if (order.status === 'EXPIRED' || order.status === 'CANCELLED') {
    checks.orderStatus.passed = false;
    checks.orderStatus.detail = `Order status: ${order.status}`;
    return buildResult(checks, `Order is ${order.status.toLowerCase()}`);
  }

  checks.orderStatus.passed = true;
  checks.orderStatus.detail = `Order status: ${order.status}`;

  // ==================== Amount Check ====================
  const expectedRemaining = order.remainingAmount || order.expectedAmount;
  const amountDiff = Math.abs(expectedRemaining - input.amount);

  if (amountDiff < 0.01) {
    checks.amount.passed = true;
    checks.amount.expected = expectedRemaining;
    checks.amount.detail = `Exact match: ${input.amount}`;
  } else if (input.amount > expectedRemaining) {
    // Overpayment
    checks.amount.passed = false;
    checks.amount.expected = expectedRemaining;
    checks.amount.detail = `Overpayment: expected ${expectedRemaining}, received ${input.amount}`;
  } else {
    // Underpayment
    checks.amount.passed = false;
    checks.amount.expected = expectedRemaining;
    checks.amount.detail = `Underpayment: expected ${expectedRemaining}, received ${input.amount}, short ${expectedRemaining - input.amount}`;
  }

  // ==================== Currency Check ====================
  if (input.currency === order.currency) {
    checks.currency.passed = true;
    checks.currency.expected = order.currency;
    checks.currency.detail = 'Currency matches';
  } else {
    checks.currency.passed = false;
    checks.currency.expected = order.currency;
    checks.currency.detail = `Expected ${order.currency}, received ${input.currency}`;
  }

  // ==================== Recipient Check ====================
  if (input.recipientAccountId && order.recipient) {
    const normalized = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/[*]/g, '');
    if (normalized(input.recipientAccountId) === normalized(order.recipient)) {
      checks.recipient.passed = true;
      checks.recipient.detail = 'Recipient matches';
    } else {
      // Soft check — not a hard fail
      checks.recipient.passed = true;
      checks.recipient.detail = `Recipient mismatch (soft): expected "${order.recipient}", got "${input.recipientAccountId}"`;
    }
  } else {
    checks.recipient.passed = true;
    checks.recipient.detail = 'Recipient not verifiable (missing data)';
  }

  // ==================== Timestamp Check ====================
  if (input.occurredAt && order.createdAt) {
    const diffMs = input.occurredAt.getTime() - order.createdAt.getTime();
    if (diffMs < 0) {
      checks.timestamp.passed = false;
      checks.timestamp.detail = 'Payment time is before order creation';
    } else if (diffMs > 60 * 60 * 1000) {
      // More than 1 hour — soft warning
      checks.timestamp.passed = true;
      checks.timestamp.detail = `Payment ${Math.floor(diffMs / 60000)} min after order (warn: long gap)`;
    } else {
      checks.timestamp.passed = true;
      checks.timestamp.detail = `Payment ${Math.floor(diffMs / 60000)} min after order`;
    }
  } else {
    checks.timestamp.passed = true;
    checks.timestamp.detail = 'Timestamp not verifiable';
  }

  // ==================== Final Decision ====================
  const allCriticalPassed =
    checks.idempotency.passed &&
    checks.orderStatus.passed &&
    checks.amount.passed &&
    checks.currency.passed;

  if (allCriticalPassed) {
    return buildResult(checks, 'All critical checks passed');
  }

  // Determine specific failure reason
  if (!checks.amount.passed && input.amount > expectedRemaining) {
    return buildResult(checks, `Overpayment: received ${input.amount}, expected ${expectedRemaining}`);
  }
  if (!checks.amount.passed && input.amount < expectedRemaining) {
    return buildResult(checks, `Underpayment: received ${input.amount}, expected ${expectedRemaining}`);
  }
  if (!checks.currency.passed) {
    return buildResult(checks, `Currency mismatch: ${input.currency} vs ${order.currency}`);
  }

  return buildResult(checks, 'Verification failed');
}

// ==================== Save Verification Result ====================

export async function saveVerification(
  paymentId: string,
  result: VerificationResult,
): Promise<void> {
  await prisma.paymentVerification.create({
    data: {
      paymentId,
      amountVerified: result.checks.amount.passed,
      currencyVerified: result.checks.currency.passed,
      recipientVerified: result.checks.recipient.passed,
      timestampVerified: result.checks.timestamp.passed,
      idempotencyVerified: result.checks.idempotency.passed,
      status: result.passed ? 'verified' : 'failed',
      reason: result.reason,
      checks: result.checks as any,
    },
  });
}

// ==================== Helpers ====================

function buildResult(checks: VerificationResult['checks'], reason: string): VerificationResult {
  const passed =
    checks.idempotency.passed &&
    checks.orderStatus.passed &&
    checks.amount.passed &&
    checks.currency.passed;

  return { passed, checks, reason };
}