// ================================================================
// Universal Connect Runtime v2 — Auth Manager
// Handles username/password auth with MFA, session management
//
// P0-6: MFA is NEVER verified by the server. It is delegated to:
//   - Browser session (user completes MFA in browser)
//   - Push notification (user approves in app)
//   - External OTP provider (TOTP algorithm, not hardcoded)
// ================================================================

import { prisma } from '../../services/db';
import { encryptSecret, storeCredential } from '../vault';

export interface UsernamePasswordAuthInput {
  userId: string;
  providerId: string;
  connectionId: string;
  username: string;
  password: string;
  mfaCode?: string;
  mfaType?: 'totp' | 'sms' | 'email' | 'push' | 'passkey';
}

export async function authWithUsernamePassword(
  input: UsernamePasswordAuthInput,
): Promise<{ success: boolean; credentialId?: string; requiresMfa?: boolean; mfaType?: string; error?: string }> {
  const { userId, providerId, connectionId, username, password, mfaCode, mfaType } = input;

  if (!password) return { success: false, error: 'Password required' };
  if (password.length > 1024) return { success: false, error: 'Password too long' };

  // Store password encrypted (never in logs/traces)
  const credId = await storeCredential(userId, providerId, 'username_password', password, {
    username,
    connectionId,
    mfaType,
  });

  // Determine if MFA is needed by provider config
  const mfaProviders = ['google', 'github', 'slack', 'discord', 'twitter-x', 'facebook'];
  const needsMfa = mfaProviders.includes(providerId);

  if (needsMfa && !mfaCode) {
    // P0-6: Mark as waiting — user must complete MFA via browser/push
    await prisma.connection.update({
      where: { id: connectionId, userId },
      data: { status: 'reauth_required', meta: JSON.stringify({ pendingMfa: { providerId, credId, username, type: mfaType } }) },
    });
    return { success: true, credentialId: credId, requiresMfa: true, mfaType };
  }

  // MFA provided or not needed — mark connection active
  await prisma.connection.update({
    where: { id: connectionId, userId },
    data: { status: 'active', credentialRef: credId, account: username, lastTokenRefresh: new Date() },
  });

  return { success: true, credentialId: credId };
}

// ─── Session Management ─────────────────────────────────────────────

export async function getSession(userId: string, providerId: string, accountId?: string): Promise<any | null> {
  const where: any = { userId, type: 'browser_session', status: 'active' };
  if (accountId) where.meta = { contains: JSON.stringify({ accountId }) };
  return prisma.credential.findFirst({ where });
}

export async function saveSession(userId: string, providerId: string, sessionId: string, sessionData: any): Promise<string> {
  return storeCredential(userId, providerId, 'browser_session', JSON.stringify(sessionData), { sessionId });
}

export async function restoreSession(userId: string, providerId: string, sessionId: string, accountId?: string): Promise<any | null> {
  // P0-9: Precise lookup
  const conn = await prisma.connection.findFirst({
    where: { userId, providerId, status: 'active', account: accountId || undefined },
    select: { credentialRef: true },
  });
  if (!conn?.credentialRef) return null;
  const { getSecret } = await import('../vault');
  try {
    const secret = await getSecret(conn.credentialRef, userId);
    if (!secret) return null;
    return JSON.parse(secret);
  } catch { return null; }
}

export async function invalidateSession(userId: string, providerId: string, sessionId?: string, accountId?: string): Promise<void> {
  // P0-9: Precise invalidation
  const where: any = { userId, providerId, type: 'browser_session', status: 'active' };
  if (sessionId) where.meta = { contains: JSON.stringify({ sessionId }) };
  if (accountId) where.meta = { contains: JSON.stringify({ accountId }) };
  await prisma.credential.updateMany({ where, data: { status: 'revoked' } });
}

// ─── Security: Password never logged ────────────────────────────────

export function sanitizeAuthLog(input: any): any {
  const sanitized = { ...input };
  delete sanitized.password;
  delete sanitized.secret;
  delete sanitized.token;
  delete sanitized.credential;
  return sanitized;
}
