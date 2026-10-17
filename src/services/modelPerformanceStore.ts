// ================================================================
// Model Performance Store — Runtime performance tracking
// Stores actual performance metrics per model for adaptive routing
// ================================================================

export interface PerformanceRecord {
  ttftMs: number;          // Time to first token
  tokensPerSec: number;    // Tokens per second
  errorRate: number;       // Error rate (0-1)
  timeoutRate: number;     // Timeout rate (0-1)
  rateLimitRate: number;   // 429 rate (0-1)
  fallbackRate: number;    // Fallback rate (0-1)
  successRate: number;     // Task success rate (0-1)
  verificationRate: number; // Verification pass rate (0-1)
  totalRequests: number;
  lastUpdated: string;
}

interface PerformanceStore {
  [modelKey: string]: PerformanceRecord;
}

const performanceStore: PerformanceStore = {};

const WINDOW_SIZE = 50; // Number of recent requests to consider

export function updatePerformance(
  modelKey: string,
  metrics: Partial<PerformanceRecord>,
): void {
  const now = new Date().toISOString();
  const existing = performanceStore[modelKey] || {
    ttftMs: 0,
    tokensPerSec: 0,
    errorRate: 0,
    timeoutRate: 0,
    rateLimitRate: 0,
    fallbackRate: 0,
    successRate: 1,
    verificationRate: 1,
    totalRequests: 0,
    lastUpdated: now,
  };

  performanceStore[modelKey] = {
    ttftMs: metrics.ttftMs ?? existing.ttftMs,
    tokensPerSec: metrics.tokensPerSec ?? existing.tokensPerSec,
    errorRate: metrics.errorRate ?? existing.errorRate,
    timeoutRate: metrics.timeoutRate ?? existing.timeoutRate,
    rateLimitRate: metrics.rateLimitRate ?? existing.rateLimitRate,
    fallbackRate: metrics.fallbackRate ?? existing.fallbackRate,
    successRate: metrics.successRate ?? existing.successRate,
    verificationRate: metrics.verificationRate ?? existing.verificationRate,
    totalRequests: existing.totalRequests + 1,
    lastUpdated: now,
  };
}

export function recordSuccess(modelKey: string, ttftMs: number, tokensPerSec: number): void {
  const existing = performanceStore[modelKey] || {
    ttftMs: 0,
    tokensPerSec: 0,
    errorRate: 0,
    timeoutRate: 0,
    rateLimitRate: 0,
    fallbackRate: 0,
    successRate: 1,
    verificationRate: 1,
    totalRequests: 0,
    lastUpdated: new Date().toISOString(),
  };

  const decay = 0.95;
  performanceStore[modelKey] = {
    ttftMs: Math.min(ttftMs, existing.ttftMs * decay + ttftMs * (1 - decay)),
    tokensPerSec: Math.max(tokensPerSec, existing.tokensPerSec * decay + tokensPerSec * (1 - decay)),
    errorRate: existing.errorRate * decay,
    timeoutRate: existing.timeoutRate * decay,
    rateLimitRate: existing.rateLimitRate * decay,
    fallbackRate: existing.fallbackRate * decay,
    successRate: Math.min(1, existing.successRate * decay + 1 * (1 - decay)),
    verificationRate: existing.verificationRate,
    totalRequests: existing.totalRequests + 1,
    lastUpdated: new Date().toISOString(),
  };
}

export function recordFailure(modelKey: string, reason: 'error' | 'timeout' | 'rate_limit' | 'fallback'): void {
  const existing = performanceStore[modelKey] || {
    ttftMs: 0,
    tokensPerSec: 0,
    errorRate: 0,
    timeoutRate: 0,
    rateLimitRate: 0,
    fallbackRate: 0,
    successRate: 1,
    verificationRate: 1,
    totalRequests: 0,
    lastUpdated: new Date().toISOString(),
  };

  const decay = 0.9;
  const updates: Partial<PerformanceRecord> = { errorRate: existing.errorRate * decay + 1 * (1 - decay), successRate: existing.successRate * decay };

  if (reason === 'timeout') updates.timeoutRate = (existing.timeoutRate ?? 0) * decay + 1 * (1 - decay);
  if (reason === 'rate_limit') updates.rateLimitRate = (existing.rateLimitRate ?? 0) * decay + 1 * (1 - decay);
  if (reason === 'fallback') updates.fallbackRate = (existing.fallbackRate ?? 0) * decay + 1 * (1 - decay);

  performanceStore[modelKey] = { ...existing, ...updates, totalRequests: existing.totalRequests + 1, lastUpdated: new Date().toISOString() };
}

export function recordVerification(modelKey: string, passed: boolean): void {
  const existing = performanceStore[modelKey] || {
    ttftMs: 0,
    tokensPerSec: 0,
    errorRate: 0,
    timeoutRate: 0,
    rateLimitRate: 0,
    fallbackRate: 0,
    successRate: 1,
    verificationRate: 1,
    totalRequests: 0,
    lastUpdated: new Date().toISOString(),
  };

  const decay = 0.95;
  performanceStore[modelKey] = {
    ...existing,
    verificationRate: passed ? Math.min(1, existing.verificationRate * decay + 1 * (1 - decay)) : existing.verificationRate * decay,
    totalRequests: existing.totalRequests + 1,
    lastUpdated: new Date().toISOString(),
  };
}

export function getPerformance(modelKey: string): PerformanceRecord | null {
  return performanceStore[modelKey] || null;
}

export function getAllPerformance(): PerformanceStore {
  return { ...performanceStore };
}

export function resetPerformance(modelKey: string): void {
  delete performanceStore[modelKey];
}

export function getHealthScore(modelKey: string): number {
  const perf = performanceStore[modelKey];
  if (!perf || perf.totalRequests < 3) return 0.7; // Default health for untested models

  // Health score = weighted combination of success rate, error rate, and reliability
  const health = perf.successRate * 0.4 + (1 - perf.errorRate) * 0.3 + (1 - perf.timeoutRate) * 0.2 + (1 - perf.rateLimitRate) * 0.1;
  return health;
}
