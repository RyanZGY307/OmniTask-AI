// ================================================================
// Prompt Runtime Routes
// ================================================================

import { Router, Response } from 'express';
import { authMiddleware, adminAuth, AuthRequest } from '../middleware/auth';
import { runPromptRuntime } from '../services/promptRuntime';
import { prismaKnowledge } from '../services/db';
import { upsertAtom, setAtomStatus, getAllPublishedAtoms, compareVersions, createAtomVersion, publishAtomVersion, getAtomVersions } from '../services/promptRegistry';
import { upsertScenario, setScenarioStatus, getAllScenarios, getPublishedScenarios } from '../services/scenarioRegistry';

const router = Router();

// ==================== Compose (public) ====================

router.post('/compose', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { message, conversation_id, model, temperature, language, region } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const result = await runPromptRuntime(message, [], {
      language,
      region,
      userTier: req.user?.subscriptionTier,
      targetModel: model,
      explicitTemperature: temperature,
      userId: req.user!.id,
      requestId: conversation_id,
    });

    res.json({
      trace_id: result.traceId,
      composition_hash: result.compositionHash,
      scenario: result.classification.scenarios[0],
      task: result.classification.tasks[0],
      tasks: result.classification.tasks,
      response_mode: result.classification.response_mode,
      generation_profile: result.generationProfile,
      temperature: result.temperature,
      selected_atoms: result.composition.selected_atoms,
      removed_atoms: result.composition.removed_atoms,
      conflicts: result.conflictResult.conflicts,
      dependencies: result.dependencyResult,
      final_system_prompt: result.composition.final_prompt,
      model_request: result.modelRequest,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Composition failed' });
  }
});

// ==================== Trace query ====================

router.get('/trace/:traceId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // 轨迹属于产生它的用户；管理员可查全部（debugger 场景）
    const isAdmin = req.user!.role === 'ADMIN' || req.user!.role === 'SUPER_ADMIN';
    const trace = await prismaKnowledge.promptTrace.findFirst({
      where: { traceId: String(req.params.traceId), ...(isAdmin ? {} : { userId: req.user!.id }) },
    });
    if (!trace) return res.status(404).json({ error: 'Trace not found' });
    res.json({ trace });
  } catch {
    res.status(500).json({ error: 'Query failed' });
  }
});

// ==================== Atoms (admin) ====================

router.get('/atoms', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const category = req.query.category ? String(req.query.category as string) : undefined;
    const atoms = await getAllPublishedAtoms(category);
    res.json({ atoms });
  } catch {
    res.status(500).json({ error: 'Query failed' });
  }
});

router.post('/atoms', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await upsertAtom(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

router.post('/atoms/:id/version', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { version, instruction, metadata, created_by } = req.body;
    if (!version || !instruction) return res.status(400).json({ error: 'version and instruction required' });
    const id = await createAtomVersion({ atomId: String(String(req.params.id)), version, instruction, metadata, created_by });
    res.json({ id });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

router.put('/atoms/:id/version/:version/publish', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await publishAtomVersion(String(String(req.params.id)), String(req.params.version), req.user?.username);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

router.put('/atoms/:id/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    await setAtomStatus(String(String(req.params.id)), status);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

router.get('/atoms/:id/versions', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const versions = await getAtomVersions(String(req.params.id));
    res.json({ versions });
  } catch {
    res.status(500).json({ error: 'Query failed' });
  }
});

router.get('/atoms/:id/compare/:v1/:v2', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const comparison = await compareVersions(String(req.params.id), String(req.params.v1), String(req.params.v2));
    res.json(comparison);
  } catch {
    res.status(500).json({ error: 'Query failed' });
  }
});

// ==================== Scenarios (admin) ====================

router.get('/scenarios', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const category = req.query.category ? String(req.query.category as string) : undefined;
    const scenarios = category ? await getPublishedScenarios(category) : await getAllScenarios();
    res.json({ scenarios });
  } catch {
    res.status(500).json({ error: 'Query failed' });
  }
});

router.post('/scenarios', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = await upsertScenario(req.body);
    res.json({ id });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

router.put('/scenarios/:id/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    await setScenarioStatus(String(req.params.id), status);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

// ==================== Health ====================

router.get('/health', async (_req, res) => {
  res.json({ status: 'ok', component: 'prompt-runtime' });
});

// ==================== Extensions (admin — full lifecycle) ====================

import {
  createExtension, updateExtension, deleteExtension,
  validateExtension, testExtension, previewExtension,
  publishExtension, unpublishExtension, rollbackExtension,
  listVersions, compareVersions as compareExtVersions,
  listExtensions, getDependencies, getConflicts,
} from '../services/extensionRegistry';
import { upsertModelCapability, getModelCapability } from '../services/modelCapabilityRegistry';

router.get('/extensions', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const type = req.query.type ? String(req.query.type as string) : undefined;
    const status = req.query.status ? String(req.query.status as string) : undefined;
    const search = req.query.search ? String(req.query.search as string) : undefined;
    const extensions = await listExtensions(type, status, search);
    res.json({ extensions });
  } catch { res.status(500).json({ error: 'Query failed' }); }
});

router.post('/extensions', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = await createExtension(req.body);
    res.json({ id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/extensions/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await updateExtension(String(req.params.id), req.body);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/extensions/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await deleteExtension(String(req.params.id));
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/extensions/:id/validate', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await validateExtension(String(req.params.id));
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/extensions/:id/test', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await testExtension(String(req.params.id), req.body);
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/extensions/:id/preview', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await previewExtension(String(req.params.id));
    res.json(result);
  } catch (err: any) { res.status(404).json({ error: err.message }); }
});

router.post('/extensions/:id/publish', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { version } = req.body;
    const publishedVersion = await publishExtension(String(req.params.id), version, req.user?.username);
    res.json({ success: true, version: publishedVersion });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/extensions/:id/unpublish', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await unpublishExtension(String(req.params.id));
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/extensions/:id/rollback', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { version } = req.body;
    if (!version) return res.status(400).json({ error: 'version required' });
    await rollbackExtension(String(req.params.id), version);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/extensions/:id/versions', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const versions = await listVersions(String(req.params.id));
    res.json({ versions });
  } catch { res.status(500).json({ error: 'Query failed' }); }
});

router.get('/extensions/:id/compare/:v1/:v2', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const comparison = await compareExtVersions(String(req.params.id), String(req.params.v1), String(req.params.v2));
    res.json(comparison);
  } catch { res.status(500).json({ error: 'Query failed' }); }
});

router.get('/extensions/:id/dependencies', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const deps = await getDependencies(String(req.params.id));
    res.json(deps);
  } catch { res.status(500).json({ error: 'Query failed' }); }
});

router.get('/extensions/:id/conflicts', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const conflicts = await getConflicts(String(req.params.id));
    res.json(conflicts);
  } catch { res.status(500).json({ error: 'Query failed' }); }
});

// ==================== Model Capabilities (admin) ====================

router.get('/model-capabilities/:modelKey', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const cap = await getModelCapability(String(req.params.modelKey));
    res.json({ capability: cap });
  } catch { res.status(500).json({ error: 'Query failed' }); }
});

router.put('/model-capabilities/:modelKey', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await upsertModelCapability({ modelKey: String(req.params.modelKey), ...req.body });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ==================== Debugger / Trace ====================

router.get('/debugger/:traceId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // 同 trace 查询：非管理员只能看自己的轨迹
    const isAdmin = req.user!.role === 'ADMIN' || req.user!.role === 'SUPER_ADMIN';
    const trace = await prismaKnowledge.promptTrace.findFirst({
      where: { traceId: String(req.params.traceId), ...(isAdmin ? {} : { userId: req.user!.id }) },
    });
    if (!trace) return res.status(404).json({ error: 'Trace not found' });

    const selectedAtoms = trace.selected_atoms || [];
    const atomDetails: Array<{ id: string; version?: string; status?: string; instruction?: string; reason?: string }> = [];
    for (const atomId of selectedAtoms) {
      const atom = await prismaKnowledge.promptAtom.findUnique({
        where: { id: atomId },
        include: { versions: { where: { status: 'published' }, take: 1, orderBy: { created_at: 'desc' } } },
      });
      if (atom) {
        atomDetails.push({
          id: atomId,
          version: atom.version,
          status: atom.status,
          instruction: atom.versions[0]?.instruction?.substring(0, 200),
          reason: 'selected',
        });
      } else {
        atomDetails.push({ id: atomId, reason: 'not_found_in_registry' });
      }
    }

    for (const removedId of trace.removed_atoms || []) {
      atomDetails.push({ id: removedId, reason: 'removed_by_conflict_or_dependency' });
    }

    res.json({
      request: {
        trace_id: trace.traceId,
        request_id: trace.requestId,
        user_id: trace.userId,
        status: trace.status,
        duration_ms: trace.duration_ms,
        error_message: trace.error_message,
        target_model: trace.target_model,
      },
      classification: {
        scenario: trace.scenarioId,
        task: trace.task,
        knowledge_state: trace.knowledge_state,
        verification_state: trace.verification_state,
      },
      extensions: {
        selected_atoms: selectedAtoms,
        removed_atoms: trace.removed_atoms || [],
        atom_details: atomDetails,
        conflicts: trace.conflicts,
        dependencies: trace.dependencies,
      },
      generation_profile: (trace.atom_versions as any)?.generation_profile,
      temperature: (trace.atom_versions as any)?.temperature,
      prompt: {
        composition_hash: trace.final_prompt_hash,
        sections: trace.atom_versions,
      },
      timestamp: trace.created_at,
    });
  } catch {
    res.status(500).json({ error: 'Debugger query failed' });
  }
});

export default router;
