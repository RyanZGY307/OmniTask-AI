import { Request, Response, NextFunction } from 'express';

const requests = new Map<string, number[]>();

// Prune stale IP keys so the in-memory map cannot grow without limit
// when many unique IPs hit the limiter (memory-leak guard).
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - STALE_TTL_MS;
  for (const [key, timestamps] of requests.entries()) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
      requests.delete(key);
    }
  }
}, STALE_TTL_MS).unref();

export function rateLimit(windowMs: number, maxRequests: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const timestamps = (requests.get(key) || []).filter(t => t > now - windowMs);
    if (timestamps.length >= maxRequests) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    timestamps.push(now);
    requests.set(key, timestamps);
    next();
  };
}