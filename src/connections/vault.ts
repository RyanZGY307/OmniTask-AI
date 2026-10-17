// ================================================================
// Credential Vault — AES-256-GCM encrypted secret storage
// Secrets are never returned to callers in logs/traces; only
// credentialRef IDs and metadata are exposed.
// ================================================================

import crypto from 'crypto';
import { prisma } from '../services/db';

let vaultKey: Buffer | null = null;
let keySource = '';

/** P0-10: Production requires VAULT_KEY. No fallback. */
export function initVault(forceCheck = false): void {
  const raw = process.env.VAULT_KEY;
  if (!raw) {
    if (forceCheck || process.env.NODE_ENV === 'production') {
      console.error('[VAULT] FATAL: VAULT_KEY environment variable is required in production');
      throw new Error('VAULT_KEY is required — cannot start without encrypted secret storage');
    }
    console.warn('[VAULT] VAULT_KEY not set — running in dev mode with insecure key derivation');
  }
  if (raw) {
    keySource = 'VAULT_KEY env';
    const buf = Buffer.from(raw, 'base64');
    vaultKey = buf.length === 32 ? buf : crypto.createHash('sha256').update(raw).digest();
  } else {
    // Dev only: derive from JWT_SECRET (insecure, not for production)
    keySource = 'derived from JWT_SECRET (dev only)';
    vaultKey = crypto.createHash('sha256').update(`cortex-vault:${process.env.JWT_SECRET || 'default'}`).digest();
  }
}

function getVaultKey(): Buffer {
  if (vaultKey) return vaultKey;
  const raw = process.env.VAULT_KEY;
  if (raw) {
    keySource = 'VAULT_KEY env';
    const buf = Buffer.from(raw, 'base64');
    vaultKey = buf.length === 32 ? buf : crypto.createHash('sha256').update(raw).digest();
  } else {
    keySource = 'derived from JWT_SECRET (weak — set VAULT_KEY)';
    vaultKey = crypto.createHash('sha256').update(`cortex-vault:${process.env.JWT_SECRET || 'default'}`).digest();
    console.warn('[VAULT] VAULT_KEY not set — falling back to JWT_SECRET-derived key');
  }
  return vaultKey;
}

export function vaultKeySource(): string {
  return keySource || 'uninitialized';
}

interface CipherBlob { c: string; iv: string; tag: string; }

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getVaultKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob: CipherBlob = { c: enc.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') };
  return JSON.stringify(blob);
}

export function decryptSecret(secretCipher: string): string {
  const blob: CipherBlob = JSON.parse(secretCipher);
  const iv = Buffer.from(blob.iv, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getVaultKey(), iv);
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.c, 'base64')), decipher.final()]).toString('utf8');
}

// ---- Persisted operations ----

export async function storeCredential(
  userId: string,
  providerId: string,
  type: string,
  secret: string,
  meta?: Record<string, any>,
  expiresAt?: Date,
): Promise<string> {
  const cipher = encryptSecret(secret);
  const metaJson = meta ? JSON.stringify(meta) : undefined;
  const cred = await prisma.credential.upsert({
    where: { userId_providerId_type: { userId, providerId, type } },
    update: { status: 'active', secretCipher: cipher, meta: metaJson, expiresAt },
    create: { userId, providerId, type, status: 'active', secretCipher: cipher, meta: metaJson, expiresAt },
  });
  return cred.id;
}

export async function getSecret(credentialId: string, userId: string): Promise<string | null> {
  const cred = await prisma.credential.findUnique({ where: { id: credentialId } });
  if (!cred || cred.userId !== userId) return null;
  if (cred.status !== 'active') return null;
  if (cred.expiresAt && cred.expiresAt.getTime() < Date.now()) return null;
  try {
    return decryptSecret(cred.secretCipher);
  } catch {
    console.error('[VAULT] Failed to decrypt credential', cred.id, '(key source:', vaultKeySource(), ')');
    return null;
  }
}

export async function revokeCredential(credentialId: string, userId: string): Promise<void> {
  const cred = await prisma.credential.findUnique({ where: { id: credentialId } });
  if (!cred || cred.userId !== userId) return;
  await prisma.credential.update({ where: { id: credentialId }, data: { status: 'revoked' } });
}

export async function credentialStatus(credentialId: string): Promise<string | null> {
  const cred = await prisma.credential.findUnique({ where: { id: credentialId } });
  return cred ? cred.status : null;
}
