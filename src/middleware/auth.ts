import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config';
import { prisma } from '../services/db';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    username: string;
    role: string;
    subscriptionTier: string;
    region: string;
    language: string;
    file?: Express.Multer.File;
  };
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }

  let payload: { id?: string };
  try {
    payload = jwt.verify(header.split(' ')[1], env.JWT_SECRET) as { id?: string };
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }

  let user;
  try {
    user = await prisma.user.findUnique({
      where: { id: payload.id as string },
      select: {
        id: true, email: true, username: true, role: true,
        subscriptionTier: true,
        region: true, language: true, isActive: true,
      },
    });
  } catch (err: any) {
    // Database outage is not an auth failure: answering 401 here makes the
    // client treat a valid session as expired and wipe the token.
    console.error(`[AUTH] user lookup failed: ${err?.code || ''} ${err?.message || err}`);
    return res.status(503).json({ error: '服务暂时不可用，请稍后重试' });
  }

  if (!user || !user.isActive) {
    return res.status(401).json({ error: '登录已过期' });
  }

  req.user = {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    subscriptionTier: user.subscriptionTier,
    region: user.region,
    language: user.language,
  };
  next();
}

export function adminAuth(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN')) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

export function superAdminAuth(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: '需要超级管理员权限' });
  }
  next();
}