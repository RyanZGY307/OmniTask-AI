// Route+Skill：路由轮匹配技能/专业档案 → 用档案的 systemPrompt + 工具子集执行 ReAct-lite。
// 档案来源：宿主注入的 SkillRegistry（enabled 的 persona/toolset 型技能）优先；未注入时回退 BUILTIN_PROFILES
// 并在事件里如实标注 source='builtin_fallback'（不得把内置档案冒充宿主技能）。
import type { PatternRunner } from '../runner';
import type { RunContext, RunEnv, RunOutcome } from '../runner';
import { EventEmitter, RunBudget, modelTurn, toolTurn, callIdempotencyKey, toolSpecsFor } from '../runner';
import type { ModelMessage } from '../../model/types';
import type { SkillRegistry, SkillSpec } from '../skills';
import { estimateTokens, DEFAULT_POLICY } from '../compactor';

export interface SkillProfile { id: string; description: string; systemPrompt: string; toolSubset: string[]; }

/** 宿主技能 → 路由档案（persona/toolset 型可路由；knowledge/workflow 型不含执行上下文，跳过） */
export function profilesFromSkills(skills: SkillRegistry): SkillProfile[] {
  return skills.listEnabled()
    .filter((s) => s.kind === 'persona' || s.kind === 'toolset')
    .map((s: SkillSpec) => ({ id: s.id, description: s.description, systemPrompt: s.systemPrompt ?? s.description, toolSubset: (s.toolSpecs ?? []).map((t) => t.id) }));
}

/** M1 内置档案（宿主 Skill 四类型注入为后续项，见 extension-contracts §3.3） */
export const BUILTIN_PROFILES: SkillProfile[] = [
  { id: 'code_readonly', description: '只读代码勘察、定位与解释', systemPrompt: '你是只读勘察代理：只用只读工具，不下结论证据外的话。', toolSubset: ['read_file@1.0.0', 'grep@1.0.0', 'list_files@1.0.0'] },
  { id: 'file_edit', description: '小步文件编辑与重构', systemPrompt: '你是文件编辑代理：每次只做一处可验证修改。', toolSubset: ['read_file@1.0.0', 'grep@1.0.0', 'write_file@1.0.0'] },
  { id: 'general', description: '通用问答与轻任务', systemPrompt: '你是通用代理：优先直接回答，必要时调用工具。', toolSubset: ['read_file@1.0.0'] },
];

export function routeProfile(text: string, profiles: SkillProfile[] = BUILTIN_PROFILES): SkillProfile {
  // v1：规则路由（id 命中 + 域名词命中），宿主 skills[].description 语义路由为后续项（未验证项清单已登记）。
  const t = text.toLowerCase();
  const hit = profiles.find((p) => p.id === 'code_readonly' && /(定位|勘察|哪里|解释|read|locate|inspect)/.test(t))
    ?? profiles.find((p) => p.id === 'file_edit' && /(改|修|重构|edit|refactor|rename)/.test(t));
  return hit ?? profiles[profiles.length - 1];
}

/** 档案集合：注入 registry 且至少一个可路由技能 → 用宿主技能；否则内置回退（含标记） */
export function resolveProfiles(skills?: SkillRegistry): { profiles: SkillProfile[]; source: 'host_skills' | 'builtin_fallback' } {
  if (skills) {
    const fromSkills = profilesFromSkills(skills);
    if (fromSkills.length > 0) return { profiles: fromSkills, source: 'host_skills' };
  }
  return { profiles: [...BUILTIN_PROFILES], source: 'builtin_fallback' };
}

export const routeSkillRunner: PatternRunner = {
  id: 'route_skill',
  async run(ctx: RunContext, env: RunEnv): Promise<RunOutcome> {
    const emitter = new EventEmitter(env.store);
    const budget = new RunBudget(ctx);
    const { profiles, source } = resolveProfiles(env.skills);
    const profile = routeProfile(ctx.userMessage, profiles);

    if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
    if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
    const routeStep = `s${budget.steps}`;
    await emitter.emit(ctx.runId, { type: 'step.started', level: 'info', payload: { seq: budget.steps, kind: 'model', title: '路由' } });
    // 路由确认轮（可观测：为什么选这个档案）
    const confirm = await modelTurn(env, ctx, {
      stepId: routeStep,
      messages: [{ role: 'system', content: '你是路由器。' }, { role: 'user', content: `${ctx.userMessage}\n\n从以下档案选一个最匹配并给理由：\n${profiles.map((p) => `- ${p.id}: ${p.description}`).join('\n')}` }],
      tier: 'light',
    });
    if (!confirm.ok) return { state: 'failed', finalText: confirm.text, errorKind: confirm.errorKind };
    // 确认轮只在候选集合内匹配；模型答非所问时回退规则路由（不假装匹配成功）
    const picked = profiles.find((p) => confirm.text.includes(p.id));
    const routed = picked ?? profile;
    await emitter.emit(ctx.runId, { type: 'step.succeeded', level: 'info', payload: { stepId: routeStep, title: `路由→${routed.id}`, reason: confirm.text.slice(0, 200), source, candidates: profiles.map((p) => p.id) } });

    const tools = toolSpecsFor(env.tools).filter((t) => routed.toolSubset.includes(t.name));
    // 宿主技能的子集若在 registry 里不存在 → 如实降级为空并事件留痕（不得注入不存在的工具）
    let messages: ModelMessage[] = [{ role: 'system', content: routed.systemPrompt }, ...ctx.history, { role: 'user', content: ctx.userMessage }];
    const ctxWindow = env.model.describe({ tier: ctx.depth === 'd3' ? 'strong' : 'standard' }).contextWindow;
    for (let i = 0; i < ctx.limits.maxSteps - 1; i++) {
      if (budget.exhausted) return { state: 'budget_exhausted', reason: 'limits' };
      // M2：运行期上下文超软阈值→压缩（user.input 原话由 Compactor protectedRoles 保护）
      const { tokens } = estimateTokens(messages);
      if (tokens / ctxWindow >= DEFAULT_POLICY.softRatio) {
        const compacted = await env.onCompact?.(ctx.runId, messages, ctxWindow);
        if (compacted) messages = compacted;
      }
      if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
      if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
      const stepId = `s${budget.steps}`;
      const r = await modelTurn(env, ctx, { stepId, messages, tools, tier: 'standard' });
      if (!r.ok) return { state: 'failed', finalText: r.text, errorKind: r.errorKind };
      if (r.toolCalls.length === 0) {
        await emitter.emit(ctx.runId, { type: 'run.completed', level: 'info', payload: { finalText: r.text, profile: routed.id, source } });
        return { state: 'completed', finalText: r.text };
      }
      messages.push({ role: 'assistant', content: r.text });
      for (const call of r.toolCalls) {
        if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
        const t = await toolTurn(env, ctx, { stepId: `s${budget.steps}`, call, argsJson: JSON.stringify(call.args), idemKey: callIdempotencyKey(`s${budget.steps}`, call.id) });
        if (t.kind === 'waiting_approval') return { state: 'waiting_approval', approvalId: t.approvalId!, promptSummary: t.summary, decisionKey: t.decisionKey };
        messages.push({ role: 'tool', content: JSON.stringify(t.result?.output ?? { ok: false }), toolCallId: call.id, name: call.name });
      }
    }
    return { state: 'budget_exhausted', reason: 'maxSteps' };
  },
};
