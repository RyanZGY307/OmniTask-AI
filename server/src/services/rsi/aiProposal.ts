// ================================================================
// AI Proposal Engine — 复用 callAgnes，显式指定评估模型，结构化输出。
// 提议与评估分离：proposerModel ≠ evaluatorModel（不同 env 配置）。
// ================================================================

import { callAgnes } from '../scenarioWorkers/agnesCaller';
import { acquireRsiGate } from './rsiQuotaGate';
import { getRsiProvider } from './rsiProviderConfig';
import { parseProposalStrict } from './candidateValidator';
import type { ProposalPayload, RiskLevel } from './types';

export const PROPOSAL_ALLOWED_ENUMS: Record<string, string[]> = {
  changeKind: ['add', 'modify', 'retire'],
};

export interface AiProposalRequest {
  assetType: string;
  assetKey: string;
  currentContent: string;
  evidenceSummary: string;      // 已脱敏（调用 evidenceAssembler 后传入）
  signalKinds: string[];
}

export interface AiProposalResult {
  ok: boolean;
  proposal?: ProposalPayload;
  raw?: string;
  reason?: string;
  modelUsed?: string;
}

function buildPrompt(req: AiProposalRequest): { system: string; user: string } {
  const system = '你是 OmniTask 受控自我改进引擎的候选提议员。只依据给定证据提出一处最小化、可验证的资产内容改进。禁止提出针对系统提示词、安全规则、权限、源码、迁移、密钥、插件或他人记忆的变更。只输出 JSON。';
  const user = [
    `资产类型: ${req.assetType}`,
    `资产键: ${req.assetKey}`,
    `当前内容:\n${req.currentContent.slice(0, 4000)}`,
    `信号类型: ${req.signalKinds.join(',')}`,
    `证据摘要:\n${req.evidenceSummary.slice(0, 3000)}`,
    '输出JSON字段: { "assetType": "...", "assetKey": "...", "changeKind": "add|modify|retire", "content": "改进后的完整内容", "hypothesis": "可验证的因果假设", "instructionDelta": "与当前版本的差异说明" }',
  ].join('\n');
  return { system, user };
}

/**
 * RSI 独立额度/并发门：与普通 API 管理共用算法但密钥与配置数据完全独立。
 * 未启用 / 额度类阻塞一律直接拒绝，绝不降级到普通 Provider 配置（任务书硬约束）。
 */
async function checkRsiQuotaOrBlock(req: AiProposalRequest, riskLevel: RiskLevel): Promise<string | null> {
  const provider = process.env.RSI_PROVIDER || 'omnitask';
  const cfg = await getRsiProvider(provider, 'PRO');
  if (!cfg) return `rsi_provider_unconfigured`;
  if (cfg.enabled === false) return 'rsi_provider_disabled';
  const gate = acquireRsiGate({
    provider,
    tier: 'PRO',
    apiKey: '',
    modelKey: String(req.assetKey),
    estTokens: 1200,
  });
  if (!gate.ok) return `rsi_quota_blocked:${gate.reason}`;
  return null;
}

function parseNum(v: string | undefined): number | null {
  const n = Number(v ?? '');
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** 提议生成：失败返回 ok:false，绝不伪造候选。 */
export async function proposeCandidate(req: AiProposalRequest, riskLevel: RiskLevel = 'r1'): Promise<AiProposalResult> {
  const { system, user } = buildPrompt(req);
  // 额度/并发门：预算不足即跳过，不烧 token
  const blocked = await checkRsiQuotaOrBlock(req, riskLevel);
  if (blocked) return { ok: false, raw: '', reason: blocked, modelUsed: 'rsi-quota-gate' };
  try {
    const raw = await callAgnes(system, user, {
      model: process.env.RSI_PROPOSER_MODEL,     // 未配置则用调用器默认
      temperature: 0,
      maxTokens: 900,
      timeoutMs: parseInt(process.env.RSI_PROPOSER_TIMEOUT_MS || '60000', 10) || 60000,
    });
    const parsed = parseProposalStrict(parseJsonLoose(raw), PROPOSAL_ALLOWED_ENUMS);
    if (parsed.ok === false) return { ok: false, raw, reason: (parsed as { ok: false; reason: string }).reason };
    // 强制回填资产标识，防止模型换目标
    const p = parsed.value;
    p.assetType = req.assetType;
    p.assetKey = req.assetKey;
    p.hypothesis = p.hypothesis.slice(0, 500);
    p.content = p.content.slice(0, 20000);
    return { ok: true, proposal: p, raw, modelUsed: process.env.RSI_PROPOSER_MODEL || 'agnes-3.0-flash(default)' };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err) };
  }
}

/** 宽松 JSON 提取：复用 Worker 的贪婪最后一段策略，与 parseWorkerJson 口径一致。 */
export function parseJsonLoose(raw: string): unknown {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export interface AiAssistEvaluation {
  safe: boolean;
  quality: 'improved' | 'same' | 'degraded';
  pass: boolean;
  reason: string;
}

const EVAL_ENUMS: Record<string, string[]> = { quality: ['improved', 'same', 'degraded'] };

/** 辅助评估：只能作为辅助证据，且必须使用独立模型与独立 key 提供方。 */
export async function assistEvaluation(input: {
  proposal: ProposalPayload;
  evidenceSummary: string;
  riskLevel: RiskLevel;
}): Promise<AiAssistEvaluation | null> {
  try {
    const raw = await callAgnes(
      '你是 OmniTask 受控自我改进引擎的独立评估员。你的结论只作为辅助证据，不单独决定发布。只输出JSON。',
      [
        `风险等级: ${input.riskLevel}`,
        `假说: ${input.proposal.hypothesis}`,
        `内容:\n${input.proposal.content.slice(0, 3000)}`,
        `证据摘要:\n${input.evidenceSummary.slice(0, 2000)}`,
        '输出JSON: { "safe": true|false, "quality": "improved|same|degraded", "pass": true|false, "reason": "简短理由" }',
      ].join('\n'),
      {
        model: process.env.RSI_EVALUATOR_MODEL,   // 与提议方不同条目
        temperature: 0,
        maxTokens: 200,
        timeoutMs: parseInt(process.env.RSI_EVALUATOR_TIMEOUT_MS || '45000', 10) || 45000,
      },
    );
    const parsed = parseProposalStrict(parseJsonLoose(raw), EVAL_ENUMS);
    if (!parsed.ok) return null;
    const o = parsed.value as unknown as Record<string, unknown>;
    return {
      safe: o.safe === true,
      quality: (EVAL_ENUMS.quality as string[]).includes(String(o.quality)) ? (o.quality as AiAssistEvaluation['quality']) : 'same',
      pass: o.pass === true,
      reason: String(o.reason ?? '').slice(0, 300),
    };
  } catch {
    return null; // 评估失败不阻断流程，只降级为"无辅助证据"
  }
}
