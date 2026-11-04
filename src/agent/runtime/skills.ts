// Skill 注册表（extension-contracts §3.3）：四类型 + 四要求准入门（未过门=不得注册）。
// 四类型：knowledge（知识）/ workflow（流程）/ toolset（工具集）/ persona（人格+工具集）。
// 四要求：声明式输入输出 schema、版本化、可回滚（卸载不影响其他 skill）、可测试（至少一条冒烟）。
import type { ToolSpec } from '../tools/registry';

export type SkillKind = 'knowledge' | 'workflow' | 'toolset' | 'persona';

export interface SkillSpec {
  id: string;
  semver: string;
  kind: SkillKind;
  description: string;
  systemPrompt?: string;
  toolSpecs?: ToolSpec[];          // toolset/persona 携带
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** 四要求自检证据（注册时校验） */
  conformance: {
    hasSchemas: boolean;
    versioned: boolean;
    rollbackSafe: boolean;         // 卸载只移除自身注册项，不触碰其他
    hasSmokeTest: boolean;
  };
  status: 'draft' | 'enabled' | 'disabled';
}

export class SkillRegistry {
  private items = new Map<string, SkillSpec>();

  register(spec: SkillSpec): { ok: true } | { ok: false; reasons: string[] } {
    const reasons: string[] = [];
    if (spec.kind !== 'knowledge') {
      if (!spec.conformance.hasSchemas || !spec.inputSchema || !spec.outputSchema) reasons.push('缺输入/输出 schema（知识型可豁免）');
    } else if (!spec.inputSchema || !spec.outputSchema) {
      reasons.push('knowledge 型也需声明输入/输出 schema');
    }
    if (!spec.conformance.versioned || !/^\d+\.\d+\.\d+$/.test(spec.semver)) reasons.push('未版本化（semver）');
    if (!spec.conformance.rollbackSafe) reasons.push('卸载不可回滚（不得触碰其他 skill 的注册项）');
    if (!spec.conformance.hasSmokeTest) reasons.push('无冒烟测试');
    if (reasons.length > 0) return { ok: false, reasons };
    this.items.set(spec.id, spec);
    return { ok: true };
  }

  setStatus(id: string, status: SkillSpec['status']): void {
    const s = this.items.get(id);
    if (s) s.status = status;
  }

  /** 卸载：只删自身（回滚安全的可验证性） */
  uninstall(id: string): boolean {
    return this.items.delete(id);
  }

  listEnabled(): SkillSpec[] {
    return [...this.items.values()].filter((s) => s.status === 'enabled');
  }

  get(id: string): SkillSpec | undefined { return this.items.get(id); }

  /** 扩散面：enabled skill 提供的全部工具（供模型侧 ToolSpecRef 注入） */
  toolsFromSkills(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const out: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    for (const s of this.listEnabled()) {
      for (const t of s.toolSpecs ?? []) out.push({ name: t.id, description: t.description, inputSchema: t.inputSchema });
    }
    return out;
  }
}
