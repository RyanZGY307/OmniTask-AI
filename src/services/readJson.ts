// ================================================================
// readJson — 带体积上限的 JSON 读取（新代码护栏）
// ================================================================
//
// 平台规则：大 JSON 要增量解析，别整段吞。
//
// 现实是：仓里约 30 处 `await res.json()`，绝大多数 payload 只有几百字节
// （鉴权、状态、配置）。把它们全改成流式解析是反模式——纯粹增加复杂度和
// 出错面。真正危险的不是"哪里有 res.json()"，而是"哪里的 JSON 体积会随
// 用户内容增长"：那种接口今天几百字节，某天有人往里塞了会随对话长度膨胀
// 的字段，CPU 就被悄无声息地吃爆了，而且无从排查。
//
// 所以这里的策略是：**旧代码不动，新代码一律走本工具**。
// 超过 maxBytes 就报警并拒绝，让"某天突然变大"在第一现场暴露，而不是等
// 线上 CPU 打满才回头翻 30 个调用点。
//
// 已知的真正大响应已分别处理（不走本工具）：
//   · provider 模型清单      → providerConfig.ts 的内存 TTL 缓存
//   · GitHub 仓库内容        → userSkillInstall.ts 的 ETag 条件请求
//   · 模型 SSE 响应体        → models.ts 直接 pipe，全程不进 JSON.parse

import { log } from './logger';

export const DEFAULT_MAX_JSON_BYTES = 256 * 1024; // 256 KB

export class JsonTooLargeError extends Error {
  constructor(
    public readonly url: string,
    public readonly actualBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`JSON 响应过大，已拒绝：${actualBytes} bytes > 上限 ${maxBytes}（${url}）`);
    this.name = 'JsonTooLargeError';
  }
}

/**
 * 读取 JSON，超过 maxBytes 直接抛错（不解析）。
 *
 * 体积判断优先用 Content-Length（拿不到才退化为读完整 body 再量），
 * 所以"拒绝"是真的拒绝——不会先把整段搬进内存再量。
 * 典型的 config / health / 鉴权响应都在几百字节内，256 KB 上限留有几百倍余量。
 */
export async function readJson<T = any>(
  res: Response,
  opts: { url?: string; maxBytes?: number; label?: string } = {},
): Promise<T> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const url = opts.url ?? '';
  const label = opts.label ?? 'readJson';

  const declared = res.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    log('WARN', label, `JSON 超限已拒（按 Content-Length）：${url} ${declared} > ${maxBytes}`);
    throw new JsonTooLargeError(url, Number(declared), maxBytes);
  }

  const text = await res.text();
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes > maxBytes) {
    log('WARN', label, `JSON 超限已拒（按实际体积）：${url} ${bytes} > ${maxBytes}`);
    throw new JsonTooLargeError(url, bytes, maxBytes);
  }
  return JSON.parse(text) as T;
}
