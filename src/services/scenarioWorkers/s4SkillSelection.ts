// ================================================================
// S4 Final Skill Selection — deterministic terminal rule (zero AI).
// ================================================================
// 分级与选择已由 skillGrade.ts 完成（硬门 → A/B/C/D/EXCLUDED → 上限 2 →
// 第二技能互补收益检查）。本模块不再自己判断"该不该用某个 Skill"，只做：
//   - 去重（同一 skill_id 绝不选两次）
//   - 把分级结果换算成既有 S4Output 形状，供持久化与链路追踪
//   - 生成人类可读的 selection_reason（含被硬门拦下的原因，便于复盘误选）
//   - 观察队列：未入选的 B/C 级，只作实验候选，绝不自动选中
//
// 保留的不变量：
//   - 空选集是合法终态（selected = []）；
//   - 非空候选集不强制产生选择；
//   - C/D/EXCLUDED 不进入 selected。
// ================================================================

import type { SkillGradeOutput } from '../skillGrade';

export interface S4Input {
  /** skillGrade.gradeSkills() 的输出 —— 选择已在其中完成 */
  graded: SkillGradeOutput;
  scenario: { id: string; name: string; category: string };
  user_tier?: string; // permission tier
  experiment_constraints?: string[];
}

export interface S4Output {
  selected_skill_ids: string[]; // allowed to be []
  empty_selection: boolean;
  confidence: number;
  selection_reason: string;
  rejected_skill_ids: string[];
  experiment_candidates: string[];
}

export async function runS4(input: S4Input): Promise<S4Output> {
  const output = input.graded;
  const gradedById = new Map(output.graded.map((g) => [g.skill_id, g]));

  // Dedup by skill_id (a duplicate must never both be selected).
  const selected = [...new Set(output.selectable)];
  const selectedGrades = selected.map((id) => gradedById.get(id)?.grade ?? 'D');

  const empty_selection = selected.length === 0;

  // Confidence reflects evidence quality, not "we managed to pick something":
  // all-A → high; a downgrade (task-necessary B) → moderate; empty → low.
  const allA = selectedGrades.length > 0 && selectedGrades.every((g) => g === 'A');
  const anyDowngrade = selectedGrades.some((g) => g !== 'A');
  const confidence = empty_selection ? 0.3 : allA ? 0.85 : anyDowngrade ? 0.6 : 0.5;

  const parts: string[] = [];
  if (selected.length) {
    parts.push(`selected: ${selected.map((id) => {
      const g = gradedById.get(id);
      return `${id}(${g?.grade ?? '?'}:${g?.score ?? 0}${g?.reason_codes.length ? ' ' + g.reason_codes.join('+') : ''})`;
    }).join(', ')}`);
  } else {
    parts.push('no skill meets the applicability bar -> empty selection');
  }
  if (output.excluded.length) {
    const why = output.excluded.map((id) => `${id}[${gradedById.get(id)?.gate ?? 'gate'}]`).join(', ');
    parts.push(`excluded by hard gate: ${why}`);
  }
  if (output.staged.length) parts.push(`staged (experiment only): ${output.staged.join(', ')}`);
  if (output.cap_trimmed) parts.push('candidate list exceeded the skill cap and was trimmed');
  if (input.user_tier) parts.push(`tier=${input.user_tier}`);
  const selection_reason = parts.join('; ') || 'no skill candidates';

  return {
    selected_skill_ids: selected,
    empty_selection,
    confidence,
    selection_reason,
    rejected_skill_ids: [...new Set(output.excluded)],
    experiment_candidates: output.staged,
  };
}
