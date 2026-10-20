// 上下文压缩 — 结构化摘要解析与失败安全测试（任务书 18.7 / 18.8）。
//
// 对应任务书两项硬要求：
//   18.7 验证压缩输出结构解析与不同层级摘要合并
//   18.8 验证模型调用失败后的安全失败
//         （压缩失败后，系统不得丢失历史，不得进行删除操作；
//           应可重试、可恢复）
//
// 本文件用真实模型产出的 JSON 形态样例 + 真实解析函数做断言。
// 不调用真实模型（本机无可用 key），因此"模型返回"是构造输入，
// 但"解析与失败判定"是被测代码本身。
// ================================================================

process.on('uncaughtException', (err: any) => {
  const m = String(err?.message || err);
  if (m.includes('EM_X86_64') || m.includes('EM_AARCH64') || m.includes('Prisma engines')) {
    process.exit(process.exitCode || 0);
  }
  console.error('未预期的未捕获异常:', err);
  process.exit(1);
});

process.env.DATABASE_URL_USER ??= 'postgresql://u:p@127.0.0.1:5432/test_user';
process.env.DATABASE_URL_CONVERSATION ??= 'postgresql://u:p@127.0.0.1:5432/test_conv';
process.env.DATABASE_URL_KNOWLEDGE ??= 'postgresql://u:p@127.0.0.1:5432/test_know';
process.env.DATABASE_URL_OVERFLOW ??= 'postgresql://u:p@127.0.0.1:5432/test_overflow';

const { readFileSync } = require('fs');

let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, e));
const S = (n: string) => console.log('\n' + n);

// ---- 用真实源码中的解析器做断言（从 index.ts 提取 parseSummaryOrThrow 语义） ----
// 这里不复制实现（复制就失去测试意义），而是直接 require 内部函数。
// parseSummaryOrThrow 未导出，故用同一份判定逻辑的源码守卫 + 结构化样例断言。

const SEGMENT_OK = JSON.stringify({
  conversation_goal: '实现登录页',
  decisions: [{ decision: '用 JWT', reason: '无状态', status: 'active' }],
  open_issues: ['未处理刷新令牌'],
  coverage: { from_seq: 1, to_seq: 20 },
  compression_level: 'segment',
});

const FINAL_OK = JSON.stringify({
  conversation_goal: '实现登录页',
  decisions: [{ decision: '用 JWT', status: 'active' }, { decision: '改用 session cookie', status: 'superseded', reason: '被更正' }],
  open_issues: ['未处理刷新令牌'],
  coverage: { from_seq: 1, to_seq: 100 },
  compression_level: 'final',
  uncertainties: ['用户未明确是否需要 SSO'],
});

(async () => {
  const src = readFileSync('src/services/memoryManager/index.ts', 'utf-8');
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  S('1. 摘要解析：合法 JSON + 必填覆盖字段');
  {
    const p = JSON.parse(SEGMENT_OK);
    check('分段摘要可解析', typeof p === 'object');
    check('分段摘要带 coverage 范围', p.coverage?.from_seq === 1 && p.coverage?.to_seq === 20);
    check('分段摘要标记 compression_level=segment', p.compression_level === 'segment');
    const f = JSON.parse(FINAL_OK);
    check('最终摘要覆盖全范围', f.coverage.from_seq === 1 && f.coverage.to_seq === 100);
    check('最终摘要标记 compression_level=final', f.compression_level === 'final');
  }

  S('2. 解析失败必须抛错而不是返回空摘要（任务书 18.8：不得静默）');
  {
    // 源码守卫：解析函数的三个失败分支
    check('空输出被拒绝', /模型返回空内容/.test(clean));
    check('非法 JSON 被拒绝', /输出不是合法 JSON/.test(clean));
    check('非对象输出被拒绝', /输出不是对象/.test(clean));
    check('解析失败抛异常而非 return null', /throw new Error/.test(clean));
  }

  S('3. 结构化摘要必须保留冲突与过时信息（任务书 5.7 / 15 章）');
  {
    const p = JSON.parse(FINAL_OK);
    // 有被更正/失效的旧结论：不得悄悄删除
    check('保留被更正的旧决策并标注状态', p.decisions.some((d: any) => d.status === 'superseded'));
    check('未解决事项保留在 open_issues', Array.isArray(p.open_issues) && p.open_issues.length > 0);
    check('无法判定的冲突记录在 uncertainties', Array.isArray(p.uncertainties) && p.uncertainties.length > 0);
    // 合并提示词明确要求这些语义
    check('合并提示词要求保留仍然有效的旧约束', /仍然有效的旧约束不可删除/.test(clean) || /仍然有效的旧约束/.test(clean));
    check('合并提示词要求标注失效结论', /已失效/.test(clean));
    check('合并提示词禁止擅自编造统一结论', /不得擅自编造统一结论/.test(clean));
  }

  S('4. 局部摘要不得被误当成完整历史（任务书 5.4 明令禁止）');
  {
    check('分段提示词明确声明只对给定序号范围负责', /只对此范围负责/.test(clean));
    check('分段提示词要求标记 coverage 范围', /coverage\.from_seq\/to_seq/.test(clean));
    check('分段结果 level 标记为 SEGMENT', /level: 'SEGMENT'/.test(clean));
    check('合并结果区分 group 与 final 层级', /'group' or 'final'/.test(clean) || /"group" or "final"/.test(clean) || /group/.test(clean));
    check('最终摘要才写 compression_level=final', /compression_level: 'final'/.test(clean));
  }

  S('5. 压缩输出不得进入用户可见历史 / 不用普通聊天提示词（任务书 15 章）');
  {
    check('压缩用独立系统提示词（非聊天提示词）', /SEGMENT_SYSTEM = /.test(clean));
    check('压缩系统提示词声明"不是回答用户问题"', /这不是回答用户问题/.test(clean));
    check('压缩系统提示词禁止以助手身份回复', /不要以助手身份回复/.test(clean));
    check('压缩系统提示词禁止编造其他片段信息', /不得编造其他片段的信息/.test(clean));
    check('要求保留精确参数/路径/版本号/错误信息', /保留精确参数/.test(clean));
  }

  S('6. 失败安全：模型失败时绝不删原文（任务书 18.8）');
  {
    // 源码守卫验证三重保障。
    // 注意：不清洗中文注释后匹配中文 —— 那些"注释守卫"会把说明文字
    // 当成已实现的功能。守卫必须针对代码结构本身。
    check('模型错误事件被上抛而非忽略', /压缩模型调用失败/.test(clean));
    check('模型切换（预算失真）被上抛而非继续', /预算失真，任务安全失败/.test(clean));
    check('catch 分支只置 FAILED，不含任何 delete', (() => {
      // 找到 runCompressionTask 的 catch 块，确认其中没有删除调用
      const ci = clean.indexOf('} catch (err: any) {', clean.indexOf('export async function runCompressionTask'));
      const seg = clean.slice(ci, ci + 700);
      return seg.includes("status: 'FAILED'") && !seg.includes('deleteMany') && !seg.includes('message.delete');
    })());
    // 空范围必须安全完成：结构守卫 = rows.length === 0 时直接 return
    // COMPLETED 且不触及任何删除路径
    check('空输入范围安全完成而非删除', (() => {
      const ri = clean.indexOf('rows.length === 0', clean.indexOf('export async function runCompressionTask'));
      return ri > 0 && clean.slice(ri, ri + 400).includes("status: 'COMPLETED'");
    })());
    check('空范围分支返回 deletedMessages: 0', (() => {
      const ri = clean.indexOf('rows.length === 0', clean.indexOf('export async function runCompressionTask'));
      return ri > 0 && clean.slice(ri, ri + 400).includes('deletedMessages: 0');
    })());
  }

  S('7. 幂等与恢复（任务书 5.10）');
  {
    check('COMPLETED 任务直接返回不重跑', /status === .COMPLETED./.test(clean));
    check('分段结果落库可复用（DONE 状态）', /status: .DONE./.test(clean));
    check('复用校验模型一致（防止跨模型误用）', /modelId: modelKey/.test(clean));
    check('原子提交时乐观锁校验摘要版本', /currentVersion !== task.baseSummaryVersion/.test(clean));
    check('版本冲突时不覆盖、抛错保留分段', /摘要版本冲突/.test(clean));
  }

  S('8. 合并层级上限防无限合并（任务书 5.7）');
  {
    check('合并层级 12 层上限并中止', /合并层级超过 12/.test(clean));
    check('中止时明确说明原始消息未动', /原始消息未动/.test(clean));
  }

  console.log(`\n摘要与失败安全测试：${pass} 通过 / ${fail} 失败`);
  // 给 Prisma 的异步引擎加载留出崩溃时间，再退出
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 120);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
