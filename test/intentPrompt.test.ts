// ================================================================
// Intent Understanding supplement — 默认必发系统提示词注入验证
// 运行：npx tsx test/intentPrompt.test.ts
// 验证两条真实组装路径（主 composePrompt / 兜底 compilePrompt）都：
//   - 包含新章节（标题 + 完整原文）
//   - 原有规则保留（未删除/改写）
//   - Truth Standard 仍是最后一段
//   - 无重复注入
// ================================================================

import { compilePrompt } from '../src/services/compiler';
import { composePrompt } from '../src/services/promptComposer';
import { KERNEL_INTENT_UNDERSTANDING, KERNEL_TRUTH } from '../src/services/kernel';

const TITLE = 'NATURAL-LANGUAGE INTENT UNDERSTANDING AND AMBIGUITY RESOLUTION';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  console.log('=== 1. compilePrompt（兜底路径） ===');
  const compiled = compilePrompt({
    userId: 'u1',
    userTier: 'STANDARD',
    userName: 'tester',
    message: '优化一下这个',
    taskClassification: { taskType: 'writing', suggestedAgent: 'general', suggestedSkills: [] } as any,
    memories: [],
    ragChunks: [],
    conversationHistory: [],
  });

  check('包含新章节标题', compiled.system.includes(TITLE));
  check('包含完整原文（逐字）', compiled.system.includes(KERNEL_INTENT_UNDERSTANDING));
  check('原有 kernel 保留（Identity/Authority/Safety/Behavior/Completion/Truth）',
    compiled.system.includes('You are OmniTask') &&
    compiled.system.includes('Authority hierarchy') &&
    compiled.system.includes('Safety rules') &&
    compiled.system.includes('Behavioral guidelines') &&
    compiled.system.includes('Completion rules'));
  check('Truth Standard 仍是最后一段', compiled.system.endsWith(KERNEL_TRUTH));
  check('新章节只出现一次（无重复注入）',
    (compiled.system.match(new RegExp(TITLE, 'g')) || []).length === 1);

  console.log('\n=== 2. composePrompt（主路径） ===');
  const composed = await composePrompt(
    ['core.identity'],
    { language: 'zh', user_tier: 'STANDARD' },
    { versions: { 'core.identity': { version: '1.0', instruction: 'Identity atom body' } } },
  );

  check('包含新章节标题', composed.final_prompt.includes(TITLE));
  check('包含完整原文（逐字）', composed.final_prompt.includes(KERNEL_INTENT_UNDERSTANDING));
  check('原有 atom 内容保留', composed.final_prompt.includes('Identity atom body'));
  check('Truth Standard 仍是最后一段', composed.final_prompt.endsWith(KERNEL_TRUTH));
  check('新章节只出现一次（无重复注入）',
    (composed.final_prompt.match(new RegExp(TITLE, 'g')) || []).length === 1);

  console.log('\n=== 3. 章节原文完整性 ===');
  const trimmed = KERNEL_INTENT_UNDERSTANDING.trim();
  check('章节以标题开头', trimmed.startsWith(TITLE));
  check('章节包含全部 14 条规则',
    Array.from({ length: 14 }, (_, i) => i + 1).every((n) => trimmed.includes(`${n}. `)));
  check('章节以 14 条收尾（结尾句逐字一致）',
    trimmed.endsWith(
      'Always prioritize accurate understanding, evidence-based decisions, preservation of user intent, appropriate handling of uncertainty, and reliable task completion.',
    ));
}

main().then(() => {
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
});
