// ================================================================
// Task Splitter + Parallel Workers
// Splitter: issues -> worker tasks (max 8), skip empty categories
// Workers: parallel Gemini analysis ONLY — produce proposals,
// never write to the Knowledge Base.
// ================================================================

import { buildOrgWorkerPrompt, ORG_MODEL } from './orgPrompts';
import type { OrgIssue } from './orgScanner';

export const MAX_ORG_WORKERS = 8;

export type WorkerType =
  | 'OBJECT' | 'FACTS' | 'VARIANT' | 'VERSION'
  | 'EVIDENCE' | 'SOURCE' | 'RELATION' | 'CATEGORY';

const ISSUE_TO_WORKER: Record<string, WorkerType> = {
  DUPLICATE_OBJECT: 'OBJECT',
  SEMANTIC_DUPLICATE_OBJECT: 'OBJECT',
  DUPLICATE_FACT: 'FACTS',
  SEMANTIC_DUPLICATE_FACT: 'FACTS',
  MIXED_FACT: 'FACTS',
  MIXED_VARIANT: 'VARIANT',
  VARIANT_ATTRIBUTION: 'VARIANT',
  MIXED_VERSION: 'VERSION',
  VERSION_ATTRIBUTION: 'VERSION',
  ORPHAN_EVIDENCE: 'EVIDENCE',
  DUPLICATE_SOURCE: 'SOURCE',
  DUPLICATE_RELATION: 'RELATION',
  WRONG_CATEGORY: 'CATEGORY',
  STRUCTURE_ERROR: 'EVIDENCE',
};

export interface WorkerTask {
  workerType: WorkerType;
  issues: OrgIssue[];
  entityIds: string[];
}

/**
 * Split issues into per-worker-type tasks.
 * Deterministic tasks with obvious resolutions are marked so the executor
 * can resolve them in code without Gemini.
 */
export function splitTasks(issues: OrgIssue[]): { tasks: WorkerTask[]; geminiTasks: WorkerTask[]; deterministicTasks: WorkerTask[] } {
  const byType = new Map<WorkerType, OrgIssue[]>();
  for (const issue of issues) {
    const wt = ISSUE_TO_WORKER[issue.issueType];
    if (!wt) continue;
    const list = byType.get(wt) ?? [];
    list.push(issue);
    byType.set(wt, list);
  }

  const tasks: WorkerTask[] = [];
  const geminiTasks: WorkerTask[] = [];
  const deterministicTasks: WorkerTask[] = [];

  for (const [workerType, workerIssues] of byType) {
    const entityIds = [...new Set(workerIssues.flatMap((i) => i.entityIds))];
    const task: WorkerTask = { workerType, issues: workerIssues, entityIds };
    tasks.push(task);
    // Fully deterministic issue sets (all deterministic=true) resolve in code
    if (workerIssues.every((i) => i.deterministic)) deterministicTasks.push(task);
    else geminiTasks.push(task);
  }

  // Hard cap: if more than MAX_ORG_WORKERS need Gemini, keep highest-impact types
  if (geminiTasks.length > MAX_ORG_WORKERS) {
    geminiTasks.sort((a, b) => b.issues.length - a.issues.length);
    const kept = geminiTasks.slice(0, MAX_ORG_WORKERS);
    // overflow tasks keep their deterministic issues; semantic issues in overflow are recorded as unresolved
    for (const dropped of geminiTasks.slice(MAX_ORG_WORKERS)) {
      const detOnly = dropped.issues.filter((i) => i.deterministic);
      if (detOnly.length > 0) deterministicTasks.push({ ...dropped, issues: detOnly });
    }
    geminiTasks.length = 0;
    geminiTasks.push(...kept);
  }

  return { tasks, geminiTasks, deterministicTasks };
}

// ---------------- Parallel worker execution ----------------

export interface OrgProposal {
  workerType: string;
  action: string;
  targetType: string;
  targetId: string;
  before: string;
  after: string;
  payload: Record<string, any>;
  reason: string;
}

export interface WorkerResult {
  workerType: string;
  proposals: OrgProposal[];
  uncertain: string[];
  usedGemini: boolean;
  error?: string;
}

/**
 * Run worker tasks in parallel. Each worker receives the snapshot slice for
 * its assigned entities and produces proposals only.
 * Deterministic tasks are resolved in code (no Gemini call).
 * geminiCallsUsed is incremented by the caller's counter callback.
 */
export async function runWorkers(
  tasks: WorkerTask[],
  geminiTasks: WorkerTask[],
  snapshotEntities: any,
  callGemini: (prompt: string) => Promise<string>,
  onGeminiCall?: () => void,
  concurrency = MAX_ORG_WORKERS,
): Promise<{ results: WorkerResult[]; geminiCallsUsed: number }> {
  const results: WorkerResult[] = [];
  let geminiCallsUsed = 0;

  // Deterministic tasks: resolve without Gemini
  for (const task of tasks.filter((t) => !geminiTasks.includes(t))) {
    results.push(resolveDeterministicTask(task));
  }

  // Gemini tasks: bounded concurrency, each with its own prompt
  const limit = Math.max(1, concurrency);
  let cursor = 0;
  const nextTask = () => {
    const task = geminiTasks[cursor];
    cursor++;
    return task;
  };
  const runners = Array.from(
    { length: Math.min(limit, geminiTasks.length) },
    async () => {
      for (let task = nextTask(); task; task = nextTask()) {
        const slice = buildSnapshotSlice(snapshotEntities, task.entityIds);
        const prompt = buildOrgWorkerPrompt(task.workerType, JSON.stringify(slice));
        try {
          onGeminiCall?.();
          geminiCallsUsed++;
          const raw = await callGemini(prompt);
          const parsed = extractJson(raw);
          if (!parsed || !Array.isArray(parsed.proposals)) {
            results.push({ workerType: task.workerType, proposals: [], uncertain: [], usedGemini: true, error: 'malformed response' });
            continue;
          }
          results.push({
            workerType: task.workerType,
            proposals: parsed.proposals
              .filter((p: any) => p && typeof p.action === 'string' && typeof p.targetId === 'string')
              .map((p: any) => ({
                workerType: task.workerType,
                action: String(p.action),
                targetType: String(p.targetType ?? ''),
                targetId: String(p.targetId),
                before: String(p.before ?? ''),
                after: String(p.after ?? ''),
                payload: (p.payload && typeof p.payload === 'object') ? p.payload : {},
                reason: String(p.reason ?? ''),
              })),
            uncertain: Array.isArray(parsed.uncertain) ? parsed.uncertain.map(String) : [],
            usedGemini: true,
          });
        } catch (err: any) {
          results.push({ workerType: task.workerType, proposals: [], uncertain: [], usedGemini: true, error: String(err?.message ?? err) });
        }
      }
    },
  );
  await Promise.all(runners);

  return { results, geminiCallsUsed };
}

// ---------------- Deterministic resolution (no Gemini) ----------------

function resolveDeterministicTask(task: WorkerTask): WorkerResult {
  const proposals: OrgProposal[] = [];
  for (const issue of task.issues) {
    if (!issue.deterministic) continue;
    switch (issue.issueType) {
      case 'DUPLICATE_FACT': {
        // Keep the earliest-created fact; mark others DUPLICATE with mergedInto
        const facts = issue.entityIds;
        const [keepId, ...dupIds] = facts;
        for (const dupId of dupIds) {
          proposals.push({
            workerType: task.workerType,
            action: 'MARK_LIFECYCLE',
            targetType: 'fact',
            targetId: dupId,
            before: 'ACTIVE',
            after: 'DUPLICATE',
            payload: { mergedInto: keepId },
            reason: `exact duplicate of fact ${keepId}`,
          });
        }
        break;
      }
      case 'DUPLICATE_SOURCE': {
        const [keepId, ...dupIds] = issue.entityIds;
        for (const dupId of dupIds) {
          proposals.push({
            workerType: task.workerType,
            action: 'NORMALIZE_SOURCE',
            targetType: 'source',
            targetId: dupId,
            before: 'separate source',
            after: `merged into source ${keepId}`,
            payload: { mergedInto: keepId },
            reason: 'sources normalize to the same canonical URL',
          });
        }
        break;
      }
      case 'DUPLICATE_RELATION': {
        const [keepId, ...dupIds] = issue.entityIds;
        for (const dupId of dupIds) {
          proposals.push({
            workerType: task.workerType,
            action: 'MERGE_RELATION',
            targetType: 'relation',
            targetId: dupId,
            before: 'separate relation rows',
            after: `merged into relation ${keepId}`,
            payload: { mergedInto: keepId },
            reason: 'identical object+target+relationType',
          });
        }
        break;
      }
      case 'ORPHAN_EVIDENCE': {
        proposals.push({
          workerType: task.workerType,
          action: 'MARK_LIFECYCLE',
          targetType: 'evidence',
          targetId: issue.entityIds[0],
          before: 'orphan evidence',
          after: 'ARCHIVED',
          payload: { lifecycleStatus: 'ARCHIVED' },
          reason: 'evidence is connected to no fact; archived, kept for history',
        });
        break;
      }
      default:
        break; // other deterministic issue types handled by Gemini workers or left untouched
    }
  }
  return { workerType: task.workerType, proposals, uncertain: [], usedGemini: false };
}

// ---------------- Snapshot slicing ----------------

function buildSnapshotSlice(entities: any, entityIds: string[]): any {
  const idSet = new Set(entityIds);
  const slice: any = {};
  if (entities.object && (idSet.has(entities.object.id) || entityIds.length === 0)) slice.object = entities.object;
  if (entities.facts) slice.facts = entities.facts.filter((f: any) => idSet.has(f.id) || idSet.size === 0);
  if (entities.variants) slice.variants = entities.variants.filter((v: any) => idSet.has(v.id) || idSet.size === 0);
  if (entities.sources) slice.sources = entities.sources.filter((s: any) => idSet.has(s.id) || idSet.size === 0);
  if (entities.relations) slice.relations = entities.relations.filter((r: any) => idSet.has(r.id) || idSet.size === 0);
  if (entities.evidence) slice.evidence = entities.evidence.filter((e: any) => idSet.has(e.id) || idSet.size === 0);
  if (entities.factEvidence) slice.factEvidence = entities.factEvidence.filter((fe: any) => idSet.has(fe.factId) || idSet.has(fe.evidenceId) || idSet.size === 0);
  return slice;
}

function extractJson(raw: string): any | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export { ORG_MODEL };
