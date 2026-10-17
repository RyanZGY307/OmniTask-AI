// ================================================================
// Providers API (public — catalog only, no credentials)
//   GET /api/providers
//   GET /api/providers/:id/capabilities
// ================================================================

import { Router, Response } from 'express';
import { LEGACY_PROVIDERS as PROVIDERS, providerCapabilities, getProvider } from '../connections/providers';

const router = Router();

router.get('/', (_req: any, res: Response) => {
  res.json({
    providers: PROVIDERS.map((p) => ({
      id: p.providerId,
      displayName: p.displayName,
      type: p.type,
      status: p.status,
      authMethods: p.authMethods,
      capabilityCount: p.capabilities.length,
    })),
  });
});

router.get('/:id/capabilities', (_req: any, res: Response) => {
  const p = getProvider(String(_req.params.id));
  if (!p) { res.status(404).json({ error: 'Unknown provider' }); return; }
  res.json(providerCapabilities(p.providerId));
});

export default router;
