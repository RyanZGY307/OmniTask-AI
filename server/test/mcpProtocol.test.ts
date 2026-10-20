// P2：真 MCP 协议客户端测试（JSON-RPC 2.0）。
//
// 用一个进程内的假 MCP server 做真实握手与调用 —— 不是 mock 返回值，
// 而是起一个真的 HTTP 服务，按 MCP 协议响应 JSON-RPC。这样才能验证：
//   - initialize 的 envelope、protocolVersion 协商、capabilities
//   - tools/list 发现结果，包括「成功但零工具」与「协议不兼容」的区分
//   - tools/call 的正常返回、isError 业务失败、payload 为空三种结局
//   - 超时走 unknown（外部副作用未确认），而不是 failure
//   - JSON-RPC 错误码到契约状态的映射
//
// 不访问外网，不起真实进程（用 fetch 打到本地 http server）。
// ================================================================

import http from 'http';
import { AddressInfo } from 'net';
import {
  mcpInitialize, mcpListTools, mcpCallTool, mcpHealthCheck,
  jsonRpcToConnectorResult, JSON_RPC_ERRORS,
} from '../src/connections/connectors/mcp/client';
import { isSuccess, isRetryable } from '../src/connections/contract';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, e));

/**
 * 起一个可编程的假 MCP server。
 * 约定：handler 返回**永不 resolve 的 Promise** 或 null = 服务端挂起不响应
 * （用于测客户端超时）。其他返回值按 { status, headers, body } 或裸 body 处理。
 */
async function startServer(handler: (body: any) => any): Promise<{ url: string; close: () => Promise<void>; requests: any[] }> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', () => {
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep empty */ }
      requests.push(body);
      Promise.resolve(handler(body)).then((out) => {
        // 挂起：不写任何响应，让客户端的 AbortSignal 真正触发
        if (out === null || out === undefined) return;
        const status = typeof out.status === 'number' ? out.status : 200;
        const headers = out.headers && typeof out.headers === 'object' ? out.headers : { 'Content-Type': 'application/json' };
        const payload = 'body' in out ? out.body : out;
        res.writeHead(status, headers);
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      }).catch(() => { /* handler 抛错：同样不回写，客户端按传输错误处理 */ });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

(async () => {
  // ---------------------------------------------------------------
  console.log('\n1. initialize — 真实 JSON-RPC 握手与 protocolVersion 协商');
  {
    const srv = await startServer((body) => ({
      body: {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-06-18',   // 服务端给出与我们提议不同的版本
          capabilities: { tools: {} },
          serverInfo: { name: 'FakeMCP', version: '1.2.3' },
        },
      },
    }));
    const init = await mcpInitialize({ endpoint: srv.url, timeoutMs: 5000 });
    check('握手成功', init.kind === 'ok');
    if (init.kind === 'ok') {
      check('serverInfo.name 被解析', init.serverInfo.name === 'FakeMCP');
      check('协商后的 protocolVersion 以服务端为准', init.serverInfo.negotiatedProtocolVersion === '2025-06-18');
      check('capabilities 被解析', !!init.serverInfo.capabilities?.tools);
    }
    check('请求是 JSON-RPC 2.0 envelope', srv.requests[0]?.jsonrpc === '2.0' && srv.requests[0]?.method === 'initialize');
    check('请求带 params（protocolVersion/capabilities/clientInfo）', !!srv.requests[0]?.params?.protocolVersion);
    await srv.close();
  }

  // ---------------------------------------------------------------
  console.log('\n2. tools/list — 成功发现 N 个 / 成功零个 / 协议不兼容，三者必须可区分');
  {
    const srv = await startServer((body) => ({
      body: {
        jsonrpc: '2.0', id: body.id,
        result: { tools: [
          { name: 'search', description: 'Search things', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
          { name: 'no_schema' },
          { name: '' },                       // 非法项：必须被过滤，不得进入工具表
          null,                              // 非法项
        ] },
      },
    }));
    const d = await mcpListTools({ endpoint: srv.url, timeoutMs: 5000 });
    check('发现状态为 ok', d.status === 'ok');
    check('过滤掉空 name / null，仅保留合法工具', d.tools.length === 2, JSON.stringify(d.tools.map((t) => t.name)));
    check('工具带 inputSchema', d.tools[0]?.inputSchema?.type === 'object');
    check('工具带 annotations（readOnlyHint）', (d.tools[0]?.annotations as any)?.readOnlyHint === true);
    check('无 schema 的工具 inputSchema 为 undefined', d.tools[1]?.inputSchema === undefined);
    await srv.close();
  }
  {
    // 成功但零工具 —— 合法结局，不是失败
    const srv = await startServer((body) => ({ body: { jsonrpc: '2.0', id: body.id, result: { tools: [] } } }));
    const d = await mcpListTools({ endpoint: srv.url, timeoutMs: 5000 });
    check('零工具 = ok（不是 protocol_incompatible）', d.status === 'ok' && d.tools.length === 0);
    await srv.close();
  }
  {
    // 协议不兼容：method not found
    const srv = await startServer((body) => ({ body: { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } } }));
    const init = await mcpInitialize({ endpoint: srv.url, timeoutMs: 5000 });
    check('initialize 收到 -32601 → protocol_incompatible', init.kind === 'error' && init.status === 'protocol_incompatible');
    const d = await mcpListTools({ endpoint: srv.url, timeoutMs: 5000 });
    check('tools/list -32601 → not_configured（支持握手但无工具能力）', d.status === 'not_configured');
    await srv.close();
  }
  {
    // 不是 JSON-RPC：返回纯 HTML —— 必须明确识别为协议不兼容
    const srv = await startServer(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    const init = await mcpInitialize({ endpoint: srv.url, timeoutMs: 5000 });
    check('HTML 响应 → protocol_incompatible（不是"零工具"）', init.kind === 'error' && init.status === 'protocol_incompatible');
    await srv.close();
  }

  // ---------------------------------------------------------------
  console.log('\n3. tools/call — 三种结局必须分流');
  {
    // 正常成功（structuredContent 优先）
    const srv = await startServer((body) => ({ body: { jsonrpc: '2.0', id: body.id, result: { structuredContent: { hits: 3 }, content: [{ type: 'text', text: 'raw' }] } } }));
    const r = await mcpCallTool({ endpoint: srv.url }, 'search', { q: 'x' });
    check('成功调用 status 为 success', r.status === 'success');
    check('structuredContent 优先于 content', JSON.stringify((r as any).data) === JSON.stringify({ hits: 3 }));
    check('请求带 name + arguments', srv.requests[0]?.params?.name === 'search' && srv.requests[0]?.params?.arguments?.q === 'x');
    await srv.close();
  }
  {
    // isError 业务失败
    const srv = await startServer((body) => ({ body: { jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: 'index not found' }] } } }));
    const r = await mcpCallTool({ endpoint: srv.url }, 'search', { q: 'x' });
    check('isError → failure（明确失败）', r.status === 'failure');
    check('失败原因含服务端文本', (r as any).error.includes('index not found'));
    await srv.close();
  }
  {
    // 空 result —— 不是成功
    const srv = await startServer((body) => ({ body: { jsonrpc: '2.0', id: body.id, result: {} } }));
    const r = await mcpCallTool({ endpoint: srv.url }, 'search', {});
    check('空 result → unknown（外部可能已执行但拿不到可核实内容）', r.status === 'unknown');
    check('unknown 不可无条件重试', isRetryable(r) === false);
    await srv.close();
  }

  // ---------------------------------------------------------------
  console.log('\n4. 超时 → unknown，绝不伪装成 failure');
  {
    const srv = await startServer(() => new Promise<never>(() => { /* 永不 resolve = 服务端挂起 */ }));
    const r = await mcpCallTool({ endpoint: srv.url, timeoutMs: 150 }, 'slow', {});
    check('超时 status 为 timeout', r.status === 'timeout');
    check('timeout 不可无条件重试（外部副作用未确认）', isRetryable(r) === false);
    const h = await mcpHealthCheck({ endpoint: srv.url, timeoutMs: 150 });
    check('握手超时 → unknown（非 unhealthy，也非 healthy）', h.status === 'unknown');
    await srv.close();
  }

  // ---------------------------------------------------------------
  console.log('\n5. JSON-RPC 错误码 → 契约状态映射');
  check('-32601 → unavailable（方法未实现，属协议不兼容族）', jsonRpcToConnectorResult({ code: JSON_RPC_ERRORS.METHOD_NOT_FOUND, message: 'm' }).status === 'unavailable');
  check('-32602 → failure（参数错误，可修正后重试）', jsonRpcToConnectorResult({ code: JSON_RPC_ERRORS.INVALID_PARAMS, message: 'm' }).status === 'failure');
  check('-32700 → unavailable（协议层）', jsonRpcToConnectorResult({ code: JSON_RPC_ERRORS.PARSE_ERROR, message: 'm' }).status === 'unavailable');
  check('-32603 → unknown（服务端内部错误，副作用未确认）', jsonRpcToConnectorResult({ code: JSON_RPC_ERRORS.INTERNAL_ERROR, message: 'm' }).status === 'unknown');
  check('-32000（服务端自定义）→ failure', jsonRpcToConnectorResult({ code: -32000, message: 'm' }).status === 'failure');
  check('成功结果可判定', isSuccess({ status: 'success' } as any));

  // ---------------------------------------------------------------
  console.log('\n6. 健康检查 — 握手成功即 healthy，且延迟是实测值');
  {
    const server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => raw += c);
      req.on('end', () => {
        setTimeout(() => {
          const body = raw ? JSON.parse(raw) : {};
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'H' } } }));
        }, 60);   // 人为制造可测延迟
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const h = await mcpHealthCheck({ endpoint: `http://127.0.0.1:${port}/mcp`, timeoutMs: 5000 });
    check('握手成功 → healthy', h.status === 'healthy');
    check('latencyMs 为实测值（≥人为延迟 60ms，非写死常量）', (h.latencyMs ?? 0) >= 55, `latencyMs=${h.latencyMs}`);
    check('healthy 不带 error/detail 字段', !('error' in h) && !('detail' in h));
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\nMCP 协议测试：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch((e) => { console.error('MCP 测试崩溃:', e); process.exit(1); });
