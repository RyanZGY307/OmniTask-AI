// ================================================================
// 待命规则自检：standby.ts 的纯逻辑（可见性/在线判定、id、origin、节奏）。
// 运行：<server>/node_modules/.bin/tsx client/scripts/standby-check.ts
//
// 为什么单独跑：client 的 `next build` 在这台 android/arm64 主机上不可能
// 完成——npm 上没有 Next 14.2.x 的 @next/swc-android-arm64 二进制（最高只到
// 13.2.5-canary，14.2.33 返回 404）。本脚本不依赖 Next/React/swc，只测待命
// 连接的判定规则，因此在任何环境都能跑。
// ================================================================

// standby.ts 只在函数调用时读全局对象，所以可以先装桩再 import。
const store = new Map<string, string>();
const realStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
const throwingStorage = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
  removeItem: () => { throw new Error('denied'); },
};
(globalThis as any).window = { sessionStorage: realStorage };
(globalThis as any).document = { visibilityState: 'visible' };
// Node 21+ 的 navigator 是只读 getter，必须用 defineProperty 覆盖/移除。
function setNavigator(v: unknown) {
  Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
}
setNavigator({ onLine: true });

(async () => {
  const { apiOrigin, getClientId, isStandbyEligible, STANDBY_POLL_MS, RETRY_POLL_MS, PRESENCE_TTL_MS } =
    await import('../src/lib/standby');

  let pass = 0;
  let fail = 0;
  function check(name: string, cond: boolean, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name, extra); }
  }
  function setVisibility(v: string) { (globalThis as any).document.visibilityState = v; }
  function setOnline(v: boolean) { (globalThis as any).navigator.onLine = v; }

  console.log('\n1. 心跳资格：只有"看得见且在线"才算前端在运行');
  setVisibility('visible'); setOnline(true);
  check('visible + online → 发心跳', isStandbyEligible() === true);
  setVisibility('hidden'); setOnline(true);
  check('隐藏（后台标签页）→ 不发心跳，待命不等于后台轮询', isStandbyEligible() === false);
  setVisibility('visible'); setOnline(false);
  check('离线 → 不发心跳', isStandbyEligible() === false);
  setVisibility('hidden'); setOnline(false);
  check('隐藏且离线 → 不发心跳', isStandbyEligible() === false);
  setVisibility('visible'); setOnline(true);
  check('恢复可见+联网 → 立刻恢复心跳资格', isStandbyEligible() === true);
  // navigator 缺失（极老浏览器）不应抛异常
  setNavigator(undefined);
  setVisibility('visible');
  check('navigator 缺失时不抛错，按可见即可用心跳', isStandbyEligible() === true);
  setNavigator({ onLine: true });

  console.log('\n2. per-tab id：同一标签页稳定，不同标签页互不干扰');
  const idA = getClientId();
  const idB = getClientId();
  check('同一标签页重复取到同一 id', idA === idB && idA.length > 0, `${idA} vs ${idB}`);
  store.clear();
  const idC = getClientId();
  check('清空 sessionStorage（= 新标签页）后得到不同 id', idC !== idA);

  console.log('\n3. storage 不可用（隐私模式）时退回内存 id，不抛错');
  (globalThis as any).window.sessionStorage = throwingStorage;
  let memId = '';
  try { memId = getClientId(); } catch { /* 不应到达 */ }
  check('返回一个非空 id', typeof memId === 'string' && memId.length > 0, String(memId));
  check('内存 id 可重复获取且稳定（会话内不漂移）', getClientId() === memId);
  (globalThis as any).window.sessionStorage = realStorage;

  console.log('\n4. preconnect origin：跨域才需要');
  delete process.env.NEXT_PUBLIC_API_URL;
  check('未配置 → null（不输出无意义的 preconnect）', apiOrigin() === null);
  process.env.NEXT_PUBLIC_API_URL = '/api';
  check('同源相对路径 → null', apiOrigin() === null);
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/api';
  check('绝对地址 → 只取 origin（不含 /api 路径）', apiOrigin() === 'https://api.example.com', String(apiOrigin()));
  process.env.NEXT_PUBLIC_API_URL = 'not a url';
  check('非法地址 → null，不让渲染崩在 <link href>', apiOrigin() === null);

  console.log('\n5. 节奏常量之间的关系（这些数字决定待命是否真的成立）');
  check('失败重试（5s）快于待命心跳（20s）', RETRY_POLL_MS < STANDBY_POLL_MS, `retry=${RETRY_POLL_MS} standby=${STANDBY_POLL_MS}`);
  check('前端待命心跳（20s）小于服务端存活 TTL（45s）', STANDBY_POLL_MS < PRESENCE_TTL_MS, `standby=${STANDBY_POLL_MS} ttl=${PRESENCE_TTL_MS}`);
  check('TTL 至少容纳 2 次心跳，丢一次不至于被判掉线', PRESENCE_TTL_MS >= STANDBY_POLL_MS * 2, `ttl=${PRESENCE_TTL_MS}`);
  check('服务端待命保活（15s）快于原固定 60s', PRESENCE_TTL_MS > 15_000);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
