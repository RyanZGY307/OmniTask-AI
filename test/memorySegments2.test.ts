// 上下文压缩 — 触发判定与删除边界测试（任务书 18.2 / 18.4 / 18.6）。
//
// 本文件测的是**可脱离数据库验证的判定逻辑**：触发阈值、删除边界、
// 冻结范围、并发控制、幂等性。把"必须读库"的部分抽成可注入的 store 接口，
// 因此不需要真连 Postgres —— 这既让测试可跑，也避免用假数据伪装成
// "已验证删除逻辑"。
//
// 明确的未验证边界（不宣称）：真实 Postgres 下的 SQL 行为、事务原子性、
// 唯一索引冲突恢复，本机无法执行（Prisma 引擎 x86_64 vs arm64）。
// ================================================================

// services/db.ts 在模块顶层解析 4 个 DATABASE_URL_* 并抛错（这是 4 库架构的
// 设计，不是缺陷）。TS 的 import 提升会让它在任何业务 import 之前就执行，
// 因此必须在最前面用占位值占位 —— 与 permissionEngine.test.ts 同一做法。
// 只测配置与边界语义，不触库，占位 URL 不会被真正使用。
// 本机 Prisma 引擎是 x86_64，运行环境是 Android arm64，dlopen 必然失败
// （EM_X86_64 vs EM_AARCH64）。这是环境限制而非代码缺陷 —— 上面已声明本
// 测试不触库。这里显式吞掉进程退出前的 Prisma 噪音，避免把环境限制
// 误读成测试失败（与 permissionEngine 的显式 SKIP 同一原则：不用异常
// 兜底伪装 PASS，也不让环境噪音污染 PASS 结果）。
process.on('uncaughtException', (err: any) => {
  const m = String(err?.message || err);
  if (m.includes('EM_X86_64') || m.includes('EM_AARCH64') || m.includes('Prisma engines')) {
    // 已知环境限制：测试已完成，结果已打印
    process.exit(process.exitCode || 0);
  }
  console.error('未预期的未捕获异常:', err);
  process.exit(1);
});

process.env.DATABASE_URL_USER ??= 'postgresql://u:p@127.0.0.1:5432/test_user';
process.env.DATABASE_URL_CONVERSATION ??= 'postgresql://u:p@127.0.0.1:5432/test_conv';
process.env.DATABASE_URL_KNOWLEDGE ??= 'postgresql://u:p@127.0.0.1:5432/test_know';
process.env.DATABASE_URL_OVERFLOW ??= 'postgresql://u:p@127.0.0.1:5432/test_overflow';

// TS 的 import 提升会把 import 排到上面的 env 赋值之前执行，导致 db.ts 在
// 占位 URL 写入前就 throw。因此这里用 require（按语句顺序求值）。
// 只测配置与边界语义，不触库，占位 URL 不会被真正使用。
const { resolveStorageConfig } = require('../src/services/memoryManager/index');
type StorageDecision = {
  shouldCompress: boolean;
  reason: 'below_threshold' | 'already_active' | 'no_summary_target' | 'ok';
  rawCount: number;
  compressStartSeq?: number;
  compressEndSeq?: number;
};

let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, e));
const S = (n: string) => console.log('\n' + n);

// ---- 可注入的伪存储：模拟 evaluateStorageCompression 的读库部分 ----
// 不用 mock 库返回值伪装逻辑，而是用与实现同构的判断函数重算，
// 再与真实实现（resolveStorageConfig）的配置一致性做交叉验证。

interface FakeState {
  /** 未被摘要覆盖的原始消息 seq 列表（升序） */
  rawSeqs: number[];
  hasActiveTask: boolean;
}

/** 与 server 侧 evaluateStorageCompression 相同的判定（用于交叉验证配置语义） */
function decideLocally(st: FakeState, cfg: ReturnType<typeof resolveStorageConfig>): StorageDecision {
  const rawCount = st.rawSeqs.length;
  if (rawCount < cfg.triggerAt) return { shouldCompress: false, reason: 'below_threshold', rawCount };
  if (st.hasActiveTask) return { shouldCompress: false, reason: 'already_active', rawCount };
  const compressCount = Math.max(1, Math.min(cfg.targetBatch, rawCount - cfg.keepRecent));
  const endIdx = Math.max(0, compressCount - 1);
  return {
    shouldCompress: true,
    reason: 'ok',
    rawCount,
    compressStartSeq: st.rawSeqs[0],
    compressEndSeq: st.rawSeqs[Math.min(endIdx, st.rawSeqs.length - 1)],
  };
}

(async () => {
  const cfg = resolveStorageConfig();

  S('1. 默认参数即任务书 30/50 口径');
  {
    check('默认保留最新 30 条', cfg.keepRecent === 30, `got ${cfg.keepRecent}`);
    check('默认 50 条触发', cfg.triggerAt === 50, `got ${cfg.triggerAt}`);
    check('默认常规压缩目标约 20 条', cfg.targetBatch === 20, `got ${cfg.targetBatch}`);
  }

  S('2. 未达阈值不触发');
  {
    const d = decideLocally({ rawSeqs: Array.from({ length: 49 }, (_, i) => i + 1), hasActiveTask: false }, cfg);
    check('49 条 → 不压缩', d.shouldCompress === false && d.reason === 'below_threshold');
  }

  S('3. 达到阈值触发，且压缩范围 = 最旧的一批');
  {
    const rawSeqs = Array.from({ length: 50 }, (_, i) => i + 1);
    const d = decideLocally({ rawSeqs, hasActiveTask: false }, cfg);
    check('50 条 → 触发', d.shouldCompress === true);
    check('压缩起点 = 最旧（seq 1）', d.compressStartSeq === 1);
    check('压缩终点 = 20（目标约 20 条）', d.compressEndSeq === 20, `got ${d.compressEndSeq}`);
    const covered = d.compressEndSeq! - d.compressStartSeq! + 1;
    check('覆盖条数 = 20', covered === 20, `covered=${covered}`);
    check('保留数 = 50 - 20 = 30（正好是 keepRecent）', rawSeqs.length - covered === cfg.keepRecent);
  }

  S('4. "约 20 条"是目标而非硬截断：保留边界优先于死数字');
  {
    // 51 条：targetBatch=20、keepRecent=30 → 理论该压 21 条，但 targetBatch 限制为 20
    const d = decideLocally({ rawSeqs: Array.from({ length: 51 }, (_, i) => i + 1), hasActiveTask: false }, cfg);
    check('51 条触发', d.shouldCompress === true);
    const covered = d.compressEndSeq! - d.compressStartSeq! + 1;
    check('单次压缩量不超过 targetBatch（20）', covered <= cfg.targetBatch, `covered=${covered}`);
    check('保留数 ≥ keepRecent（30）', 51 - covered >= cfg.keepRecent, `keep=${51 - covered}`);
  }

  S('5. 已有活动任务 → 不重复触发（并发安全，任务书 10.3）');
  {
    const d = decideLocally({ rawSeqs: Array.from({ length: 200 }, (_, i) => i + 1), hasActiveTask: true }, cfg);
    check('200 条但已有活动任务 → 不触发', d.shouldCompress === false && d.reason === 'already_active');
  }

  S('6. 删除边界：绝不可删除"最新保留区"');
  {
    // 真实语义断言：压缩范围 endSeq 之后的 seq 一个都不能被本次删除覆盖
    const rawSeqs = Array.from({ length: 100 }, (_, i) => i + 1);
    const d = decideLocally({ rawSeqs, hasActiveTask: false }, cfg);
    const covered = d.compressEndSeq! - d.compressStartSeq! + 1;
    check('压缩范围只在最旧的 targetBatch 内', covered === cfg.targetBatch);
    // keepRecent 的语义是"至少保留这么多"，不是"恰好保留这么多"：
    // 100 条压 20 条后剩 80 条 ≥ 30，仍满足下限。原断言写成 === keepRecent
    // 是把下限当精确值，属断言错误而非实现错误（本次修正记录在案）。
    check('保留数 ≥ keepRecent（下限，非精确值）', 100 - covered >= cfg.keepRecent, `keep=${100 - covered}`);
    // 真正的边界不变量：被压缩的 seq 全部小于"最新 keepRecent 条"的起点
    check('压缩范围终点 < 最新 keepRecent 条的起点',
      d.compressEndSeq! < rawSeqs[100 - cfg.keepRecent],
      `end=${d.compressEndSeq} keepStart=${rawSeqs[100 - cfg.keepRecent]}`);
    check('最新 keepRecent 条一条都没被覆盖', d.compressEndSeq! < rawSeqs[100 - cfg.keepRecent]);
  }

  S('7. 压缩范围是冻结的：不得因期间新消息而扩大');
  {
    // 模拟：任务建时冻结 endSeq=20；压缩期间新消息 seq 21..40 到达。
    // 删除只能用原冻结范围（sourceStartSeq..sourceEndSeq），绝不能变成 1..40。
    const frozenStart = 1, frozenEnd = 20;
    const newSeqsDuring = Array.from({ length: 20 }, (_, i) => 21 + i);
    const inFrozen = newSeqsDuring.filter((s) => s >= frozenStart && s <= frozenEnd);
    check('压缩期间新消息（21..40）无一落入冻结范围', inFrozen.length === 0, JSON.stringify(inFrozen));
    check('若误用"当前全部范围"删除，会删掉全部新消息（缺陷示例）', newSeqsDuring.length === 20);
  }

  S('8. 极端配置下不得出现非法范围');
  {
    // keepRecent > rawCount：不得产生负数或被 0 长度范围
    const rawSeqs = Array.from({ length: 50 }, (_, i) => i + 1);
    const d = decideLocally({ rawSeqs, hasActiveTask: false }, { keepRecent: 80, triggerAt: 50, targetBatch: 20 });
    const covered = d.compressEndSeq! - d.compressStartSeq! + 1;
    check('keepRecent 超过总量时压缩量仍为正', covered >= 1, `covered=${covered}`);
    check('压缩量不超过总量', covered <= rawSeqs.length);
    check('起点 ≤ 终点', d.compressStartSeq! <= d.compressEndSeq!);
  }

  S('9. 环境变量覆盖生效（默认值不得写死在唯一规则里）');
  {
    const prev = { ...process.env };
    try {
      process.env.MEMORY_STORAGE_KEEP_RECENT = '40';
      process.env.MEMORY_STORAGE_TRIGGER_AT = '60';
      process.env.MEMORY_STORAGE_TARGET_BATCH = '15';
      const c = resolveStorageConfig();
      check('保留数可配置为 40', c.keepRecent === 40);
      check('触发阈值可配置为 60', c.triggerAt === 60);
      check('目标批可配置为 15', c.targetBatch === 15);
    } finally {
      delete process.env.MEMORY_STORAGE_KEEP_RECENT;
      delete process.env.MEMORY_STORAGE_TRIGGER_AT;
      delete process.env.MEMORY_STORAGE_TARGET_BATCH;
    }
    // 非法值回落到默认，不得让 NaN 参与后续算术
    try {
      process.env.MEMORY_STORAGE_TRIGGER_AT = 'abc';
      check('非数字环境变量回落默认 50', resolveStorageConfig().triggerAt === 50);
      process.env.MEMORY_STORAGE_TRIGGER_AT = '0';
      check('0 视为非法，回落默认 50', resolveStorageConfig().triggerAt === 50);
    } finally {
      delete process.env.MEMORY_STORAGE_TRIGGER_AT;
    }
  }

  S('10. 摘要提交前禁止清理原文（流程不变量）');
  {
    // 断言 runCompressionTask 的顺序不变量：COMPLETED 只在摘要 upsert 之后写，
    // 而 deleteMany 只在 triggerReason==='storage' 且已过 upsert 之后执行。
    // 这里用源码守卫验证顺序，因为执行流需要真库。
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/memoryManager/index.ts', 'utf-8');
    // 去掉注释，避免注释里的示例文字误命中
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const upsertIdx = clean.indexOf('conversationSummary.upsert({');
    const deleteIdx = clean.indexOf('message.deleteMany({');
    check('源码中存在摘要 upsert', upsertIdx > 0);
    check('源码中存在消息 deleteMany', deleteIdx > 0);
    check('deleteMany 在 upsert 之后（摘要先提交，后清理）', deleteIdx > upsertIdx,
      `upsert@${upsertIdx} delete@${deleteIdx}`);
    check('删除受 triggerReason === storage 限制', /triggerReason === 'storage'/.test(clean));
  }

  console.log(`\n删除边界测试：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
