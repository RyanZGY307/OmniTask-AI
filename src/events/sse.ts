// Agent 事件 SSE 帧编解码（宿主 chat SSE 同族；data 行为 JSON 信封）
// 帧格式：`event: <type>\ndata: <json>\n\n`；注释行(:)与 retry: 行忽略。
// 解码器按 chunk 喂入，正确处理 TCP 分片边界（拆分/粘连）。
import type { AgentEvent } from './types.ts';

export function encodeFrame(e: AgentEvent): string {
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

/** 增量 SSE 解码器：feed(chunk) → 本 chunk 内完整帧对应的事件 */
export class SseDecoder {
  private buf = '';
  feed(chunk: string): AgentEvent[] {
    this.buf += chunk;
    const out: AgentEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const frame = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith(':') || line.startsWith('retry:')) continue;
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      try {
        out.push(JSON.parse(dataLines.join('\n')) as AgentEvent);
      } catch {
        // 坏帧不崩溃、不进主链：记录为可观测事件（安全红线：不得静默吞）
        out.push({ id: 'bad_frame', runId: '', seq: -1, type: 'run.failed', level: 'error', ts: new Date().toISOString(), payload: { raw: dataLines.join('') } });
      }
    }
    return out;
  }

  get pending(): string {
    return this.buf;
  }
}

/** 终态帧（宿主既有 SSE 语义的收尾） */
export function encodeDone(): string {
  return 'event: done\ndata: {"done":true}\n\n';
}
