import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  console.error(`[${new Date().toISOString()}] ERROR:`, err);
  // Sanitize error message to avoid leaking internal details (stack traces,
  // SQL fragments, provider errors) to clients on 5xx responses.
  const isServerError = (err.status || 500) >= 500;
  res.status(err.status || 500).json({
    error: isServerError ? '服务器内部错误' : (err.message || '未知错误'),
  });
}