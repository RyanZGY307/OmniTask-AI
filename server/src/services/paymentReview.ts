// ================================================================
// Payment Review — OCR + Vision via Agnes (Data Extraction Layer)
// ================================================================
//
// This module ONLY extracts data from screenshots.
// It does NOT make financial decisions.
// Extracted data is piped to PaymentRuntime for attribution/verification/credit.
//
// AI is an extraction layer, NOT a financial authority.

import { prisma } from './db';
import crypto from 'crypto';
import { PROVIDER_BASE_URLS } from '../config';

// ==================== Agnes Helper (visual extraction) ====================

async function callAgnesForReview(systemPrompt: string, userPrompt: string, maxTokens: number, imageBase64?: string): Promise<string> {
  const { getApiKey, reportKeySuccess, reportKeyFailure } = await import('./apiKeyPool');
  const apiKey = getApiKey('agnes');
  if (!apiKey) throw new Error('No Agnes API key');

  const model = 'agnes-3.0-flash';
  const endpoint = `${PROVIDER_BASE_URLS.agnes}/chat/completions`;
  const start = Date.now();

  // Agnes is OpenAI-compatible: send the screenshot as an image_url content
  // part plus the text instruction.
  const content: any[] = [];
  if (imageBase64) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } });
  }
  content.push({ type: 'text', text: `${systemPrompt}\n${userPrompt}` });

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        temperature: 0,
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      reportKeyFailure('agnes', apiKey, `HTTP ${res.status}`);
      throw new Error(`Agnes API error: ${res.status}`);
    }

    const data: any = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (!text) {
      reportKeyFailure('agnes', apiKey, 'empty response');
      return '';
    }
    reportKeySuccess('agnes', apiKey, Date.now() - start);
    return text.trim();
  } catch (err: any) {
    if (err?.message?.startsWith('Agnes API error')) throw err;
    reportKeyFailure('agnes', apiKey, err.message);
    throw err;
  }
}

// ==================== Hash ====================

export function computeSHA256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ==================== OCR Result ====================

export interface OCRResult {
  payment_method: string;
  amount: number | null;
  currency: string;
  recipient: string;
  sender: string;
  date: string;
  time: string;
  status: string;
  transaction_id: string;
  reference_id: string;
  has_obstruction: boolean;
  obstruction_detail: string;
  phone_time: string;
  raw_text: string;
}

const DEFAULT_OCR: OCRResult = {
  payment_method: 'unknown', amount: null, currency: '', recipient: '', sender: '',
  date: '', time: '', status: '', transaction_id: '', reference_id: '',
  has_obstruction: false, obstruction_detail: '', phone_time: '', raw_text: '',
};

export async function analyzeProof(imageBase64: string): Promise<OCRResult> {
  try {
    const text = await callAgnesForReview(
      `你是付款截图OCR分析器。只输出JSON。
识别：钱包类型(tng/shopeepay/alipay/paypal/unknown)、金额、货币、收款人、发送人、日期(YYYY-MM-DD)、时间(HH:MM:SS)、状态(SUCCESS/PENDING/FAILED)、交易ID、参考号、手机左上角时间。
检查小窗遮挡：截图中是否有悬浮窗、弹窗、小窗播放、画中画、通知气泡等遮挡了交易关键区域(金额/收款人/状态/交易号)？
输出格式：{"payment_method":"tng","amount":20.00,"currency":"MYR","recipient":"RYAN TIONG KWONG NGIE","sender":"","date":"2026-09-11","time":"14:23:50","status":"SUCCESS","transaction_id":"TX001","reference_id":"","has_obstruction":false,"obstruction_detail":"","phone_time":"14:24","raw_text":"原始文字摘要"}`,
      '请分析这张付款截图，提取所有交易信息，并检查是否有小窗遮挡交易关键区域。',
      300,
      imageBase64,
    );

    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return DEFAULT_OCR;

    const parsed = JSON.parse(match[0]);
    return {
      payment_method: parsed.payment_method || 'unknown',
      amount: typeof parsed.amount === 'number' ? parsed.amount : parseFloat(parsed.amount) || null,
      currency: parsed.currency || '',
      recipient: (parsed.recipient || '').trim(),
      sender: (parsed.sender || '').trim(),
      date: parsed.date || '',
      time: parsed.time || '',
      status: (parsed.status || '').toUpperCase(),
      transaction_id: (parsed.transaction_id || '').trim(),
      reference_id: (parsed.reference_id || '').trim(),
      has_obstruction: !!parsed.has_obstruction,
      obstruction_detail: parsed.obstruction_detail || '',
      phone_time: parsed.phone_time || '',
      raw_text: parsed.raw_text || '',
    };
  } catch {
    return DEFAULT_OCR;
  }
}

// ==================== Quick Pre-Checks (before Payment Runtime) ====================

export type ReviewDecision =
  | 'PASS_TO_RUNTIME'
  | 'WINDOW_OBSTRUCTION'
  | 'PAYMENT_METHOD_MISMATCH'
  | 'AMOUNT_UNREADABLE'
  | 'UPLOAD_TOO_LATE'
  | 'DATE_BEFORE_ORDER'
  | 'DUPLICATE_FILE';

export interface PreCheckResult {
  decision: ReviewDecision;
  ocr: OCRResult;
  riskScore: number;
  reason: string;
}

export async function preCheckProof(
  orderId: string,
  proofId: string,
  imageBase64: string,
  uploadTime: Date,
): Promise<PreCheckResult> {
  const order = await prisma.paymentOrder.findUnique({ where: { orderId } });
  if (!order) return { decision: 'PASS_TO_RUNTIME', ocr: DEFAULT_OCR, riskScore: 1.0, reason: 'Order not found' };

  // File hash dedup
  const fileHash = computeSHA256(Buffer.from(imageBase64, 'base64'));
  const dupFile = await prisma.paymentProof.findFirst({ where: { fileHash, orderId } });
  if (dupFile) return { decision: 'DUPLICATE_FILE', ocr: DEFAULT_OCR, riskScore: 0.8, reason: 'Same file already uploaded' };

  // OCR extraction
  const ocr = await analyzeProof(imageBase64);

  // Save OCR to proof
  await prisma.paymentProof.update({
    where: { id: proofId },
    data: { ocrResult: ocr as any, walletType: ocr.payment_method, hasObstruction: ocr.has_obstruction, fileHash },
  });

  // Window obstruction
  if (ocr.has_obstruction) {
    return { decision: 'WINDOW_OBSTRUCTION', ocr, riskScore: 0.7, reason: `Window obstruction detected: ${ocr.obstruction_detail}` };
  }

  // Payment method mismatch
  const methodMap: Record<string, string> = { tng: 'tng', shopeepay: 'shopeepay', paypal: 'paypal', alipay: 'alipay', unknown: 'unknown' };
  const detectedMethod = methodMap[ocr.payment_method] || 'unknown';
  if (detectedMethod !== 'unknown' && detectedMethod !== order.paymentMethod) {
    return { decision: 'PAYMENT_METHOD_MISMATCH', ocr, riskScore: 0.6, reason: `Detected ${detectedMethod}, expected ${order.paymentMethod}` };
  }

  // Amount unreadable
  if (ocr.amount === null || ocr.amount === undefined) {
    return { decision: 'AMOUNT_UNREADABLE', ocr, riskScore: 0.5, reason: 'Cannot read payment amount' };
  }

  // Upload time check (5 min limit)
  if (ocr.date && ocr.time) {
    const txnTime = new Date(`${ocr.date}T${ocr.time}`);
    if (!isNaN(txnTime.getTime())) {
      const diffMs = uploadTime.getTime() - txnTime.getTime();
      if (diffMs < 0) {
        return { decision: 'DATE_BEFORE_ORDER', ocr, riskScore: 0.5, reason: 'Transaction time is in the future' };
      }
      if (diffMs > 5 * 60 * 1000) {
        return { decision: 'UPLOAD_TOO_LATE', ocr, riskScore: 0.5, reason: `Uploaded ${Math.floor(diffMs / 60000)} min after transaction` };
      }
      // Date before order check
      if (txnTime < order.createdAt) {
        return { decision: 'DATE_BEFORE_ORDER', ocr, riskScore: 0.8, reason: 'Transaction time is before order creation' };
      }
    }
  }

  return { decision: 'PASS_TO_RUNTIME', ocr, riskScore: 0, reason: 'Pre-checks passed' };
}

// ==================== Backward-Compatible Review ====================
// For any code still using the old reviewProof API

export type LegacyReviewDecision = 'PASS' | 'AMOUNT_MISMATCH' | 'INVALID_PROOF' | 'SUSPECTED_TAMPERING' | 'DUPLICATE_TRANSACTION' | 'PAYMENT_METHOD_MISMATCH' | 'RECIPIENT_MISMATCH' | 'UPLOAD_TOO_LATE' | 'WINDOW_OBSTRUCTION';

export interface LegacyReviewResult {
  decision: LegacyReviewDecision;
  aiOutput: any;
  riskScore: number;
  reason: string;
  transactionId?: string;
  verifiedAmount?: number;
}