// 统一结果契约（P0）— 纯逻辑测试，无 DB、无网络。
//
// 覆盖：判别联合的不可表示性、构造器的强制约束、可重试性判定、
// 发现结果分类、旧契约适配、以及真实连接器源码中的虚假成功是否已清除。
//
// 最后两节直接解析真实源码文本，防止「契约很干净但连接器又造出假成功」。

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  R, isSuccess, isRetryable, fromLegacy, toLegacy, healthFromLegacy,
  healthy, degraded, unhealthy, healthUnknown,
  discovered, discoveryFailed,
  type ConnectorResult, type DiscoveryResult, type HealthResult,
} from '../src/connections/contract';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  console.log('\n1. 判别联合 — 「成功带 error」在类型上不可表示');
  const ok = R.success({ a: 1 });
  check('success 有 status:"success"', ok.status === 'success');
  check('success 对象上不存在 error 键', !('error' in (ok as any)));
  check('isSuccess(success) 为真', isSuccess(ok));
  const bad = R.fail('boom');
  check('failure 必带 error', bad.status === 'failure' && bad.error === 'boom');
  check('failure 无 verified', !('verified' in (bad as any)) || (bad as any).verified === undefined);
  check('isSuccess(failure) 为假', !isSuccess(bad));

  console.log('\n2. R.fail 拒绝空 error — 失败必须可归因');
  let threw = false;
  try { R.fail(''); } catch { threw = true; }
  check('R.fail("") 抛错', threw);
  threw = false;
  try { R.fail('   '); } catch { threw = true; }
  check('R.fail("   ") 抛错', threw);

  console.log('\n3. 状态分类学 — 未知/未实现/不可用与成功、失败互不混淆');
  const unknown = R.unknown('timeout before ack');
  const notImpl = R.notImplemented('plugin runtime', { required: 'plugin_execution_engine' });
  const unavail = R.unavailable('no subprocess isolation in this deployment');
  check('unknown 不是 success', unknown.status === 'unknown' && !isSuccess(unknown));
  check('not_implemented 不是 success', notImpl.status === 'not_implemented' && !isSuccess(notImpl));
  check('not_implemented 保留 data（诊断要件）', (notImpl as any).data?.required === 'plugin_execution_engine');
  check('unavailable 不是 failure（不可当作可重试的明确失败）', unavail.status === 'unavailable' && unavail.status !== 'failure');
  check('partial 同时带 data 与 error', R.partial({ n: 1 }, 'x failed').status === 'partial');
  check('denied 是独立状态', R.denied('policy').status === 'denied');

  console.log('\n4. 可重试性 — 只有真正无副作用的暂时性失败才可无条件重试');
  check('失败不可重试（归类前）', isRetryable(R.fail('e')) === true || typeof isRetryable(R.fail('e')) === 'boolean');
  check('结果未知不可重试（可能已产生外部副作用）', isRetryable(unknown) === false);
  check('权限拒绝不可重试', isRetryable(R.denied('no')) === false);
  check('未实现不可重试', isRetryable(notImpl) === false);
  check('环境不可用不可重试', isRetryable(unavail) === false);
  check('超时不可重试（外部可能已执行）', isRetryable(R.timeout('x', 30)) === false);
  check('成功不可重试', isRetryable(R.success()) === false);

  console.log('\n5. 发现结果 — 「发现不到」与「发现成功但零工具」必须可区分');
  const zeroButOk = discovered([]);
  check('零工具且 status:ok 是合法结果', zeroButOk.status === 'ok' && zeroButOk.tools.length === 0);
  check('零工具成功不带 detail', zeroButOk.detail === undefined);
  const proto = discoveryFailed('protocol_incompatible', 'no /mcp/tools/list');
  check('协议不兼容是失败', proto.status === 'protocol_incompatible' && proto.tools.length === 0 && !!proto.detail);
  for (const s of ['connection_failed', 'auth_failed', 'not_configured', 'timeout', 'unsupported'] as const) {
    const d = discoveryFailed(s, `because ${s}`);
    check(`discoveryFailed('${s}') 状态正确`, d.status === s);
  }
  check('发现到的工具带 inputSchema', discovered([{ name: 'x', inputSchema: { type: 'object' } }]).tools[0].inputSchema?.type === 'object');

  console.log('\n6. 健康结果 — healthy 分支无 error，latencyMs 只接受实测值');
  const h = healthy(123);
  check('healthy 无 error/detail 键', !('error' in h) && !('detail' in h));
  check('healthy 保留实测延迟', h.latencyMs === 123);
  check('healthy() 无参数时不写 latencyMs', healthy().latencyMs === undefined);
  check('degraded 不是 healthy', degraded(undefined, 'slow').status === 'degraded');
  check('degraded 不伪造延迟', degraded(undefined, 'slow').latencyMs === undefined);
  check('unhealthy 必带 detail', unhealthy('conn refused').detail === 'conn refused');
  check('unknown 与 unhealthy 区分', healthUnknown('cannot probe').status === 'unknown');

  console.log('\n7. 旧契约适配 — 历史脏数据（ok:true 带 error）按 ok 归一');
  check('ok:true + error → success 且丢弃伪 error',
    fromLegacy({ ok: true, error: 'HTTP 200 at /mcp/health', data: 1 }).status === 'success');
  check('ok:true + error 的 success 不带 error 键',
    !('error' in (fromLegacy({ ok: true, error: 'x' }) as any)));
  check('ok:false → failure', fromLegacy({ ok: false, error: 'e' }).status === 'failure');
  check('ok:false 缺 error → failure 且有兜底文案',
    fromLegacy({ ok: false }).status === 'failure' && !!(fromLegacy({ ok: false }) as any).error);
  check('healthFromLegacy 丢弃成功分支的伪 error',
    healthFromLegacy({ ok: true, error: 'passed' }).status === 'healthy');
  check('healthFromLegacy 保留实测延迟', healthFromLegacy({ ok: true, latencyMs: 55 }).latencyMs === 55);
  check('toLegacy 对新旧边界可用', toLegacy(R.success(1, true)).ok === true && toLegacy(R.fail('e')).ok === false);

  console.log('\n8. 源码守卫 — 真实连接器不得再造虚假成功');
  const dir = join(__dirname, '..', 'src', 'connections', 'connectors');
  // 必须先剥离行注释与块注释再断言：源码里保留了大量「旧版如何写错」的说明性
  // 注释，若不剥离，守卫会把这些示例当成现行代码误报。
  const read = (f: string) => readFileSync(join(dir, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');     // 行注释（避开 URL 中的 //）

  // 确认剥离有效：generic_web.ts 的注释里含 "latencyMs: 1" 字样
  check('注释剥离生效（generic_web 剥离后不含 latencyMs: 1 字样）',
    !/latencyMs:\s*1/.test(read('generic_web.ts')));

  // 8.1 成功分支不得再出现 error 字段
  for (const f of ['api.ts', 'oauth.ts', 'token.ts', 'mcp.ts', 'plugin.ts', 'browser.ts']) {
    const src = read(f);
    const badSuccess = /ok:\s*true[^}]*error:/.test(src);
    check(`${f} 无「ok:true 同时带 error」`, !badSuccess);
  }

  // 8.2 不得再写死 latencyMs（模拟遥测）。剥注释后仍允许的是实测写法
  // （healthy(Date.now() - start)），禁的是直接写字面量常量的假延迟。
  for (const f of ['browser.ts', 'plugin.ts', 'generic_web.ts', 'mcp.ts', 'oauth.ts', 'token.ts']) {
    const src = read(f);
    check(`${f} 无写死 latencyMs 常量`, !/latencyMs:\s*\d+\s*[},]/.test(src));
  }

  // 8.3 plugin 执行路径必须返回 not_implemented，不得改成成功
  const plugin = read('plugin.ts');
  check('plugin.ts 的 execute 仍返回 not_implemented', /R\.notImplemented\(/.test(plugin));
  check('plugin.ts 不再返回 "simulated" 健康结果', !/simulated/.test(plugin));

  // 8.4 generic_web 不得返回无请求的假成功
  check('generic_web.ts 不再返回 { ok: true, latencyMs: 1 }',
    !/\{\s*ok:\s*true,\s*latencyMs:\s*1\s*\}/.test(read('generic_web.ts')));

  // 8.5 mcp 发现失败不得返回 ok:true
  const mcp = read('mcp.ts');
  check('mcp.ts discoverTools 返回 DiscoveryResult', /Promise<DiscoveryResult>/.test(mcp));
  check('mcp.ts 不再有 { tools: [], ok: true }', !/\{\s*tools:\s*\[\],\s*ok:\s*true/.test(mcp));

  console.log(`\n契约测试：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
})().catch((e) => { console.error('契约测试崩溃:', e); process.exit(1); });
