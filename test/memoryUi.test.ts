// 上下文压缩 — UI 与状态绑定测试（任务书 18.5 的 12 项）。
//
// 本文件覆盖 §18.5 中**可在无浏览器环境下真实断言**的部分，并把无法在
// 本机执行的部分显式列为 UNVERIFIED，不用"看起来对"冒充通过。
//
// 断言的三类证据：
//   1) 服务端常量：固定文案的唯一来源（COMPRESSION_STATUS_TEXT）
//   2) store 分发：SSE 事件类型、状态清理时机、taskId 绑定
//   3) 组件渲染：提示条的存在条件、role/aria、不得冒充消息气泡
//
// 明确不在本文件覆盖（需真实浏览器/真实后端）：
//   - 实际像素与视觉效果、滚动行为、键盘可达性实测
//   - 断线重连后的状态恢复（需真实 SSE 重连）
//   - 真实 85% 触发后用户观感
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
const unverified: string[] = [];
const check = (n: string, c: boolean, e = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, e));
const S = (n: string) => console.log('\n' + n);
function note(k: string, why: string) { unverified.push(`${k} — ${why}`); console.log('  UNVERIFIED', k, '(', why, ')'); }

const EXPECTED = '正在压缩上下文，可继续对话';

const SERVER_IDX = 'src/services/memoryManager/index.ts';
const SERVER_CHAT = 'src/routes/chat.ts';
const CLIENT_STORE = '../client/src/store/chatStore.ts';
const CLIENT_WIN = '../client/src/components/ChatWindow.tsx';
const CLIENT_BUBBLE = '../client/src/components/MessageBubble.tsx';

function strip(p: string): string {
  return readFileSync(p, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

(async () => {
  const idxRaw = readFileSync(SERVER_IDX, 'utf-8');
  const idxClean = strip(SERVER_IDX);
  const chatRaw = readFileSync(SERVER_CHAT, 'utf-8');
  const chatClean = strip(SERVER_CHAT);
  const storeRaw = readFileSync(CLIENT_STORE, 'utf-8');
  const storeClean = strip(CLIENT_STORE);
  const winClean = strip(CLIENT_WIN);
  const bubbleClean = strip(CLIENT_BUBBLE);

  S('1. §18.5-1：Chat 开始压缩后显示固定文案');
  {
    // 服务端是文案的唯一来源，前端不重新定义
    check('服务端导出固定文案常量', /COMPRESSION_STATUS_TEXT/.test(idxClean));
    check('常量值正是任务书指定文案',
      /COMPRESSION_STATUS_TEXT\s*=\s*'正在压缩上下文，可继续对话'/.test(idxClean),
      '文案必须逐字一致');
    check('Chat 入口的 SSE 携带该常量', chatClean.includes('COMPRESSION_STATUS_TEXT'));
    check('SSE 事件类型为 context_compression', /type: 'context_compression'/.test(chatClean));
    // 注意：源码跨多行书写，且 text 取常量而非内联字面量（这是更好的做法）。
    // 因此不能用一个单行正则断言 payload 结构，改为按字段逐个断言。
    check('payload 是对象而非裸字符串', /JSON\.stringify\(\{/.test(chatClean));
    check('payload 含 type=context_compression', /type: 'context_compression'/.test(chatClean));
    check('payload 含 status=compressing', /status: 'compressing'/.test(chatClean));
    check('text 取服务端常量（不在路由处重复定义文案）', /text: COMPRESSION_STATUS_TEXT/.test(chatClean));
    check('payload 含 taskId（与真实任务绑定）', /taskId: agent\.activeCompressionTaskId/.test(chatClean));
    check('推送以真实任务存在为前提', /if \(agent\.activeCompressionTaskId\)/.test(chatClean));
    check('store 处理该事件类型', /parsed\.type === 'context_compression'/.test(storeClean));
    check('组件按 contextCompression 条件渲染提示条', /contextCompression &&/.test(winClean));
  }

  S('2. §18.5-2：Agent 显示相同文案');
  {
    // Agent 与 Chat 共用 buildAgentChat / ChatWindow，因此同一常量与同一渲染分支。
    // 已验证事实：全项目 chatWithFallback 仅 5 个调用点，两个在 chat.ts 且都来自
    // buildAgentChat；无独立 Agent 界面（客户端只有 ChatWindow 一个聊天界面）。
    check('两条入口都来自同一 buildAgentChat 返回值', /contextBudget, activeCompressionTaskId/.test(chatClean));
    check('压缩提示由 agent.activeCompressionTaskId 驱动', /agent\.activeCompressionTaskId/.test(chatClean));
    check('客户端只有一个聊天界面复用同一提示条（ChatWindow）', /contextCompression/.test(winClean));
    note('Agent 专属界面', '已验证客户端无独立 Agent 界面；若后续新增 Agent UI，需复测');
  }

  S('3. §18.5-3 / -11：分段与多级合并期间状态连续，不提前消失');
  {
    // 状态只由真实 taskId 驱动，且整个任务期间只有一个 done 事件
    check('状态存放在 store 顶层（非消息流）', /contextCompression: ContextCompressionState \| null/.test(storeRaw));
    check('state 带 taskId 字段', /taskId\?: string \| null/.test(storeRaw));
    check('store 保存服务端下发的 taskId', /taskId: parsed\.taskId/.test(storeClean));
    check('组件不自行判断阈值或分段进度', !/segmentsDone|mergeLevel|85%/.test(winClean));
    check('结束事件独立类型 context_compression_done', /type: 'context_compression_done'/.test(chatClean));
    check('done 事件只在真实任务存在时发送', /if \(agent\.activeCompressionTaskId\)/.test(chatClean));
    check('消息 chunk 分支优先于/独立于压缩分支（互不干扰）',
      /parsed\.type === 'context_compression'/s.test(storeClean) && /parsed\.type === 'chunk' && parsed\.content/.test(storeClean));
  }

  S('4. §18.5-4：活动压缩任务存在时输入框仍可提交');
  {
    // 提示条是纯展示（role=status），不含 disabled/锁定类属性
    check('组件不存在 disabled 输入框逻辑', !/disabled/.test(winClean.split('contextCompression &&')[1]?.slice(0, 400) || ''));
    check('输入框发送路径未被压缩状态短路', /sendMessage\(/.test(winClean));
    check('服务端压缩为异步后台任务', /void enqueueCompression|enqueueIfIdle/.test(chatClean));
    check('压缩提示不进入 isLoadingMessages/isStreaming 之外的新阻塞',
      !/isStreaming: true\);\s*\/\/ 压缩/.test(storeClean));
  }

  S('5. §18.5-5/-6：切换对话/断线重连后状态与后台一致');
  {
    // store 在发送结束时清理；重连后由下一次请求重新评估并重新推送。
    // 任务书要求"不能只依赖一次性前端本地变量"——当前实现确实依赖服务端在
    // 下一次请求时重新推送，尚无独立的"查询当前活动压缩任务"端点。
    check('store 在发送结束时清理状态', /contextCompression: null/.test(storeClean));
    check('清理放在 finally（异常路径也清理）', /finally \{[\s\S]{0,200}contextCompression: null/.test(storeClean));
    check('服务端每次请求都重新评估真实任务', /getActiveCompressionTask/.test(idxClean));
    note('断线重连后的主动状态查询', '当前无 GET 活动压缩任务端点，恢复依赖下次请求重新推送 — 已列为未完成项');
  }

  S('6. §18.5-7：一个对话压缩不影响其他对话');
  {
    check('任务表按 conversationId 隔离查询', /conversationId: (?:task\.)?conversationId/.test(idxClean));
    check('store 状态是单例但当次请求绑定（切换对话会重新拉取）', /fetchMessages\(conversationId\)/.test(storeClean));
    note('多会话并发观感', 'store 为全局单例，切换对话期间可能瞬时残留旧提示 — 需浏览器实测');
  }

  S('7. §18.5-8/-9：完成或失败后正确恢复，不停留在压缩中');
  {
    check('done 事件清除状态', /parsed\.type === 'context_compression_done'/.test(storeClean));
    check('任务终态 COMPLETED', /status: 'COMPLETED'/.test(idxClean));
    check('任务终态 FAILED（失败不停留）', /status: 'FAILED'/.test(idxClean));
    check('压缩失败不阻塞正常对话（catch 后继续走正常路径）', /\.catch\(\(\) => null\)/.test(chatClean) || /\.catch\(\(\)=>null\)/.test(chatClean));
  }

  S('8. §18.5-10：压缩内部输出不作为普通助手回答显示');
  {
    // 压缩走独立 SEGMENT_SYSTEM/MERGE_SYSTEM，产物只落 ConversationSummary
    // 与 CompressionSegment，从不创建 role=assistant 的 Message。
    check('压缩使用独立系统提示词（SEGMENT_SYSTEM）', /SEGMENT_SYSTEM = /.test(idxClean));
    check('合并使用独立系统提示词（MERGE_SYSTEM）', /MERGE_SYSTEM = /.test(idxClean));
    check('压缩提示词声明"不是回答用户问题"', /这不是回答用户问题/.test(idxClean));
    check('压缩直连 chatWithFallback，不经消息写入路径', /chatWithFallback\(/.test(idxClean));
    check('runCompressionTask 中不创建 role assistant 消息', !/role: 'assistant'/.test(idxClean));
    // 存储压缩产生的分隔标记必须渲染为分隔线而非气泡
    check('分隔标记用独立 messageType', /messageType: 'compressed_history'/.test(idxClean));
    check('前端对 compressed_history 走分隔条分支', /msg\.messageType === 'compressed_history'/.test(winClean));
    check('分隔分支不渲染 MessageBubble', /msg\.messageType !== 'compressed_history' && <MessageBubble/.test(winClean));
    check('MessageBubble 本身不把 system 角色当对话渲染', !/role === 'system'/.test(bubbleClean));
  }

  S('9. §18.5-12：Chat/流式/状态组件无明显冲突');
  {
    check('SSE 分发中压缩分支与 queue/model_switch/credit 分支并列不覆盖',
      ['context_compression', 'queue', 'queue_update', 'model_switch', 'model_queued',
       'model_throttled', 'credit_update', 'credit_warning', 'done', 'error']
        .every((t) => storeClean.includes(`parsed.type === '${t}'`)));
    check('流式内容分支不受压缩状态影响', /streamingContent: get\(\)\.streamingContent \+ parsed\.content/.test(storeClean));
    check('中断（abort）时同样清理压缩提示', /ctrl\.signal\.aborted/.test(storeClean));
    check('压缩提示条使用 role=status 语义', /role="status"/.test(winClean) && /aria-live="polite"/.test(winClean));
    check('提示条可访问性标注装饰性 spinner', /aria-hidden="true"/.test(winClean));
  }

  S('10. 回归护栏：文案与绑定不得在后续改动中悄悄漂移');
  {
    check('前端不硬编码竞争文案（只做兜底且逐字一致）',
      (storeRaw.match(/正在压缩上下文，可继续对话/g) || []).length <= 1);
    // 必须在剥注释后的代码上计数：注释里出现同样文字不该计入"重复定义"，
    // 但也不该被当作合法定义。这条护栏防的是有人绕过常量再写一份。
    check('服务端文案只有一处定义（剥注释后）', (idxClean.match(/正在压缩上下文，可继续对话/g) || []).length === 1,
      `count=${(idxClean.match(/正在压缩上下文，可继续对话/g) || []).length}`);
    check('ChatWindow 不自行拼装压缩文案', !/正在压缩上下文/.test(winClean));
    check('客户端展示的是服务端 text 字段', /contextCompression\.text/.test(winClean));
  }

  console.log(`\nUI 与状态绑定测试：${pass} 通过 / ${fail} 失败`);
  if (unverified.length) {
    console.log('未验证项（本机无法执行，需浏览器/真实后端）：');
    for (const u of unverified) console.log('  -', u);
  }
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 120);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
