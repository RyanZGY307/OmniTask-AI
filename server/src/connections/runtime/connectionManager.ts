// ================================================================
// Universal Connect Runtime v2 — Connection Manager
// Handles CRUD for connections with multi-account support
// ================================================================

import { prisma } from '../../services/db';
import { encryptSecret, getSecret, storeCredential, revokeCredential } from '../vault';
import { selectConnector } from '../connectors/base';
import { getProviderById } from '../registry/global';
import type { ConnectionView, AuthResult } from '../types';
import type { ConnectorContext } from '../types';

// ─── Create Connection ──────────────────────────────────────────────

export interface CreateConnectionInput {
  userId: string;
  providerId: string;
  authMethod: string;
  accountName?: string;
  metadata?: Record<string, any>;
}

export async function createConnection(input: CreateConnectionInput): Promise<ConnectionView> {
  const manifest = getProviderById(input.providerId);
  if (!manifest) throw new Error(`Provider ${input.providerId} not found`);

  const conn = await prisma.connection.create({
    data: {
      userId: input.userId,
      providerId: input.providerId,
      type: input.authMethod,
      authMethod: input.authMethod,
      status: 'pending',
      permissions: JSON.stringify([]),
      scopes: JSON.stringify((manifest as any).scopes || []),
      account: input.accountName || null,
      platformManifestId: manifest.providerId,
      meta: input.metadata ? JSON.stringify(input.metadata) : null,
    },
  });

  return toConnectionView(conn, manifest);
}

// ─── Authenticate ───────────────────────────────────────────────────

export async function authenticateConnection(
  userId: string,
  connectionId: string,
  input: Record<string, any>,
): Promise<AuthResult> {
  const conn = await prisma.connection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) throw new Error('Connection not found');

  const manifest = getProviderById(conn.providerId);
  if (!manifest) throw new Error('Provider manifest not found');

  const selection = selectConnector(conn.providerId, input.toolId || 'default', input.preferredConnector);
  if (!selection) return { success: false, error: 'No connector available' };

  try {
    const ctx: ConnectorContext = {
      userId,
      connectionId,
      credentialId: conn.credentialRef || '',
      traceId: input.traceId,
      requestId: input.requestId,
    };

    const result = await selection.connector.authenticate(ctx, { ...input, providerId: conn.providerId });

    await prisma.connection.update({
      where: { id: connectionId },
      data: {
        status: result.sessionToken ? 'pending' : 'active',
        credentialRef: result.credentialId || conn.credentialRef,
        account: result.accountName || conn.account,
        lastTokenRefresh: new Date(),
      },
    });

    return {
      success: true,
      connectionId,
      credentialId: result.credentialId,
      accountId: result.accountId,
      accountName: result.accountName,
      requiresMfa: false,
      sessionToken: result.sessionToken,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── List Connections ────────────────────────────────────────────────

export async function listConnections(userId: string): Promise<ConnectionView[]> {
  const conns = await prisma.connection.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  return Promise.all(conns.map(async (conn) => {
    const manifest = getProviderById(conn.providerId);
    return toConnectionView(conn, manifest);
  }));
}

// ─── Get Connection ──────────────────────────────────────────────────

export async function getConnection(userId: string, connectionId: string): Promise<ConnectionView | null> {
  const conn = await prisma.connection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) return null;
  return toConnectionView(conn, getProviderById(conn.providerId));
}

// ─── Revoke Connection ───────────────────────────────────────────────

export async function revokeConnection(userId: string, connectionId: string): Promise<void> {
  const conn = await prisma.connection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) throw new Error('Connection not found');

  if (conn.credentialRef) await revokeCredential(conn.credentialRef, userId);
  await prisma.connection.update({ where: { id: connectionId }, data: { status: 'revoked' } });
}

// ─── Re-authenticate ─────────────────────────────────────────────────

export async function reauthenticateConnection(userId: string, connectionId: string): Promise<AuthResult> {
  const conn = await prisma.connection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) throw new Error('Connection not found');

  await prisma.connection.update({ where: { id: connectionId }, data: { status: 'reauth_required' } });
  return authenticateConnection(userId, connectionId, { reauth: true });
}

// ─── Multi-account ───────────────────────────────────────────────────

export async function addAccount(userId: string, connectionId: string, accountName: string, authInput: Record<string, any>): Promise<ConnectionView> {
  const conn = await prisma.connection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) throw new Error('Connection not found');

  const manifest = getProviderById(conn.providerId);
  if (!(manifest as any).multiAccount) throw new Error('Multi-account not supported for this provider');

  const accountConn = await prisma.connection.create({
    data: {
      userId,
      providerId: conn.providerId,
      type: conn.type,
      authMethod: conn.authMethod,
      status: 'pending',
      permissions: conn.permissions,
      scopes: conn.scopes,
      account: accountName,
      accountName,
      platformManifestId: conn.platformManifestId,
      meta: JSON.stringify({ parentConnectionId: connectionId, accountName }),
    },
  });

  return toConnectionView(accountConn, manifest);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function toConnectionView(conn: any, manifest: any): ConnectionView {
  return {
    id: conn.id,
    providerId: conn.providerId,
    providerName: manifest?.displayName || conn.providerId,
    type: conn.type,
    authMethod: conn.authMethod,
    status: conn.status,
    permissions: JSON.parse(conn.permissions || '[]'),
    scopes: JSON.parse(conn.scopes || '[]'),
    accountName: conn.accountName,
    accountIdentifier: conn.account,
    platformManifestId: conn.platformManifestId,
    lastHealthCheck: conn.lastHealthCheck,
    lastTokenRefresh: conn.lastTokenRefresh,
    multiAccount: manifest?.multiAccount || false,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

export { getSecret };
export type { ConnectionView, AuthResult };
