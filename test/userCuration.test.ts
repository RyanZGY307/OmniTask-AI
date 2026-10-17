// ================================================================
// User Curation 测试：结构校验 / 触发判定 / 动态输入与系统提示词分离 /
// （可选，CURATION_DB_TEST=1）真实数据库读写闭环。
// 运行：npx tsx test/userCuration.test.ts        （纯规则部分，无需 DB）
//      CURATION_DB_TEST=1 npx tsx test/userCuration.test.ts（含真实库读写）
// ================================================================

import {
  parseCurationOutput,
  looksLikeSecret,
} from '../src/services/userCuration/schema';
import { shouldCurate } from '../src/services/userCuration';
import { CURATION_SYSTEM_PROMPT } from '../src/services/userCuration/prompt';
import { buildCuratorUserMessage } from '../src/services/userCuration/builder';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== 1. 输出结构校验 ===');

const VALID = JSON.stringify({
  candidates: [{
    category: 'USER_PREFERENCE', scope: 'USER', operation: 'ADD',
    key: 'response.language', value: { content: '用户希望用中文回答' },
    confidence: 0.95, importance: 0.8, evidence_type: 'explicit', reason: '明确要求',
  }],
});
const valid = parseCurationOutput(VALID);
check('合法提议通过', valid.ok && valid.output!.candidates.length === 1);

const badOp = parseCurationOutput(JSON.stringify({
  candidates: [{ category: 'USER_PREFERENCE', scope: 'USER', operation: 'DROP_TABLE', key: 'k', value: { content: 'x' } }],
}));
check('非白名单 operation 被拒绝', !badOp.ok);

const badCategory = parseCurationOutput(JSON.stringify({
  candidates: [{ category: 'SOMETHING_ELSE', scope: 'USER', operation: 'ADD', key: 'k', value: { content: 'x' } }],
}));
check('非白名单 category 被拒绝', !badCategory.ok);

const updateNoTarget = parseCurationOutput(JSON.stringify({
  candidates: [{ category: 'USER_PREFERENCE', scope: 'USER', operation: 'UPDATE', key: 'k', value: { content: 'x' } }],
}));
check('UPDATE 缺 target_id 被拒绝', !updateNoTarget.ok);

const deleteNoExplicit = parseCurationOutput(JSON.stringify({
  candidates: [{ category: 'USER_PREFERENCE', scope: 'USER', operation: 'DELETE', key: 'k', value: { content: 'x' }, evidence_type: 'inferred', target_id: 'abc' }],
}));
check('DELETE 缺明确证据被拒绝', !deleteNoExplicit.ok);

const secret = parseCurationOutput(JSON.stringify({
  candidates: [{ category: 'PROJECT', scope: 'PROJECT', operation: 'ADD', key: 'k', value: { content: 'my api_key is sk-abcdef1234567890abcdef' }, evidence_type: 'explicit' }],
}));
check('秘密内容被拒绝', !secret.ok);
check('looksLikeSecret 命中常见凭据形态',
  looksLikeSecret('password: hunter2') &&
  looksLikeSecret('BEGIN RSA PRIVATE KEY'));

const notJson = parseCurationOutput('This is not JSON at all');
check('非 JSON 输出被拒绝', !notJson.ok);

const tooMany = parseCurationOutput(JSON.stringify({
  candidates: Array.from({ length: 25 }, () => ({ category: 'PROJECT', scope: 'PROJECT', operation: 'ADD', key: 'k', value: { content: 'x' } })),
}));
check('提议过多被拒绝（上限 20）', !tooMany.ok);

const noop = parseCurationOutput('{"candidates":[]}');
check('空提议合法（NOOP 是正常结果）', noop.ok && noop.output!.candidates.length === 0);

console.log('\n=== 2. 触发判定（成本控制） ===');
check('「记住」→ explicit', shouldCurate('请记住，我习惯用中文', '', 0)?.kind === 'explicit');
check('「从现在开始」→ explicit', shouldCurate('从现在开始先给结论', '', 0)?.kind === 'explicit');
check('「remember」→ explicit', shouldCurate('remember, I prefer short answers', '', 0)?.kind === 'explicit');
check('「记错了」→ correction', shouldCurate('你记错了，我现在用的是新设备', '', 0)?.kind === 'correction');
check('「actually」→ correction', shouldCurate('actually that is wrong, I use vim', '', 0)?.kind === 'correction');
check('偏好信号 → auto', shouldCurate('我更喜欢简洁一点的解释', '', 0)?.kind === 'auto');
check('普通闲聊不触发', shouldCurate('今天天气不错', '是的呢', 3) === null);
check('第 8 条消息抽样触发', shouldCurate('这段讨论里提到项目技术栈的演进历史以及多个方案的取舍过程', '较长的分析回复。'.repeat(80), 8)?.kind === 'auto');
check('非第 8 条不抽样', shouldCurate('普通长消息'.repeat(20), 'x'.repeat(50), 3) === null);

console.log('\n=== 3. 系统提示词与动态输入分离 ===');
const userMsg = buildCuratorUserMessage({
  event: {
    userMessage: '记住：回答请用中文', assistantResponse: '好的，已了解你的偏好。',
    conversationId: 'conv_test', recentMessages: [{ role: 'user', content: '记住：回答请用中文' }],
  },
  existing: { preferences: [], requirements: [], longTermMemories: [] },
  constraints: ['Do not store secrets.'],
});
check('动态输入包含当前事件', userMsg.includes('记住：回答请用中文'));
check('动态输入包含输出契约', userMsg.includes('OUTPUT CONTRACT') && userMsg.includes('"candidates"'));
check('动态输入不包含系统提示词正文', !userMsg.includes('You are OmniTask'));
check('系统提示词独立存在且非空', CURATION_SYSTEM_PROMPT.length > 2000 && CURATION_SYSTEM_PROMPT.includes('User Information Curation AI'));

// ================================================================
// 4. 真实数据库读写闭环（默认跳过；CURATION_DB_TEST=1 时执行）
//    验证：执行器写库 → 用主链路同款读路径能读回 → 归属校验 → 去重强化。
// ================================================================
function finish() {
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

if (process.env.CURATION_DB_TEST === '1') {
  console.log('\n=== 4. 真实库闭环（CURATION_DB_TEST=1） ===');
  (async () => {
  const { prisma } = await import('../src/services/db');
  const { executeCandidateOps } = await import('../src/services/userCuration/executor');
  const { getPreferences } = await import('../src/services/userMemory');
  const { getRelevantLongTermMemories } = await import('../src/services/longTermMemory');

  const email = `curation-test-${Date.now()}@example.com`;
  const u = await prisma.user.create({ data: { email, username: 'curation-test', passwordHash: 'x' } });
  try {
    // ADD 偏好 → 已存在的读路径（memoryRuntime.beforeResponse 用同一函数）能读回
    const [addPref] = await executeCandidateOps(u.id, [{
      category: 'USER_PREFERENCE', scope: 'USER', operation: 'ADD',
      key: 'preference.language', value: { content: '用户希望回答用中文' },
      confidence: 0.9, importance: 0.7, evidence_type: 'explicit', reason: 'test',
    }], 'conv_test');
    check('ADD 偏好真实写库', addPref.status === 'saved');
    const prefs = await getPreferences(u.id);
    check('主链路读路径可读回新增偏好（下次对话可注入）',
      prefs.some((p: any) => p.content.includes('回答用中文')));

    // 重复 ADD 同一内容 → 强化而非重复新增
    const [dup] = await executeCandidateOps(u.id, [{
      category: 'USER_PREFERENCE', scope: 'USER', operation: 'ADD',
      key: 'preference.language', value: { content: '用户希望回答用中文' },
      confidence: 0.9, importance: 0.7, evidence_type: 'explicit', reason: 'test-dup',
    }], 'conv_test');
    const prefsAfter = await getPreferences(u.id);
    const matches = prefsAfter.filter((p: any) => p.content.includes('回答用中文'));
    check('重复内容强化而非重复插入', dup.status === 'reinforced' && matches.length === 1);

    // UPDATE 他人/不存在的记录 → 不猜测，review_target_not_found
    const [notMine] = await executeCandidateOps(u.id, [{
      category: 'USER_PREFERENCE', scope: 'USER', operation: 'UPDATE',
      key: 'preference.language', value: { content: '改' }, target_id: 'nonexistent-id',
      confidence: 0.9, importance: 0.7, evidence_type: 'explicit', reason: 'test',
    }], 'conv_test');
    check('目标不存在 → review_target_not_found（不盲改）', notMine.status === 'review_target_not_found');

    // 长期记忆 ADD → getRelevantLongTermMemories 可检索（注入链路）
    const [addLtm] = await executeCandidateOps(u.id, [{
      category: 'PROJECT', scope: 'PROJECT', operation: 'ADD',
      key: 'project:omnitask/stack', value: { content: 'OmniTask 项目技术栈：Next.js + Express + Prisma' },
      confidence: 0.85, importance: 0.8, evidence_type: 'explicit', reason: 'test',
    }], 'conv_test');
    check('项目事实写入 LongTermMemory', addLtm.status === 'saved');
    const ltm = await getRelevantLongTermMemories(u.id, 'OmniTask 技术栈', undefined, 10);
    check('长期记忆可按关键词检索到', ltm.some((m: any) => m.content.includes('Next.js')));

    // SESSION 作用域不落长期表（不伪装保存）
    const [skipped] = await executeCandidateOps(u.id, [{
      category: 'SESSION', scope: 'SESSION', operation: 'ADD',
      key: 'session.topic', value: { content: '临时话题' },
      confidence: 0.5, importance: 0.3, evidence_type: 'inferred', reason: 'test',
    }], 'conv_test');
    check('SESSION 作用域跳过长期表（skipped_scope）', skipped.status === 'skipped_scope');

    // CurationJob 幂等：同一 dedupeKey 只能有一条
    const { createHash } = await import('crypto');
    const dedupeKey = createHash('sha256').update(`${u.id}|conv_test|dup-event`).digest('hex').slice(0, 40);
    await prisma.curationJob.create({ data: { userId: u.id, conversationId: 'conv_test', dedupeKey, status: 'saved' } });
    let dupJobRejected = false;
    try {
      await prisma.curationJob.create({ data: { userId: u.id, conversationId: 'conv_test', dedupeKey, status: 'saved' } });
    } catch { dupJobRejected = true; }
    check('CurationJob dedupeKey 唯一约束生效（幂等）', dupJobRejected);
  } finally {
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  })().then(() => finish()).catch(err => { fail++; console.log('  FAIL db-closed-loop:', err?.message ?? err); finish(); });
} else {
  console.log('\n=== 4. 真实库闭环：跳过（设 CURATION_DB_TEST=1 执行） ===');
  finish();
}
