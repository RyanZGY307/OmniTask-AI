// ================================================================
// Context compression (pure TypeScript port of the Headroom idea).
//
// Feeds the LLM prompt less for the big *data* blocks (installed-skill
// lists, RAG chunks) without touching the system-prompt core. No external
// deps, no Rust/ONNX, no network — runs in-process so it saves tokens on
// every request to end users.
//
// Gated by CORTX_CONTEXT_COMPRESSION (default ON; set 'off' to disable).
// ================================================================

export const CONTEXT_COMPRESSION_ENV = 'CORTX_CONTEXT_COMPRESSION';
const SKILL_BLOCK_COMPRESS_MIN = 800; // compact the skills block only when it exceeds this
const SKILL_PROMPT_MAX = 700;         // per-skill prompt chars before head/tail folding
const RAG_CHUNK_MAX = 300;            // per RAG chunk chars

export function isContextCompressionEnabled(): boolean {
  return process.env[CONTEXT_COMPRESSION_ENV] !== 'off';
}

/** Rough token estimate (chars / 3) — matches the app's own heuristic. */
export function estTokens(s: string): number {
  return Math.max(0, Math.round(s.length / 3));
}

/**
 * Compact an installed-skills block: keep every `## name` heading (the skill
 * identity) and the short block header, but fold any over-long per-skill
 * prompt to head/tail so a large list stops dominating the system prompt.
 */
export function compactInstalledSkillsBlock(
  block: string,
  promptMax: number = SKILL_PROMPT_MAX,
): string {
  if (block.length <= SKILL_BLOCK_COMPRESS_MIN) return block;

  const lines = block.split('\n');
  const out: string[] = [];
  let inSkill = false;
  let buffer = '';

  const flush = (): void => {
    if (!inSkill) return;
    const m = buffer.match(/^## ([^\n]*)\n?([\s\S]*)$/);
    const name = (m?.[1] ?? buffer).trim();
    let prompt = (m?.[2] ?? '').trim();
    if (prompt.length > promptMax) {
      const headLen = Math.floor(promptMax * 0.7);
      const tailLen = promptMax - headLen;
      const head = prompt.slice(0, headLen);
      const tail = prompt.slice(prompt.length - tailLen);
      const omitted = prompt.length - headLen - tailLen;
      prompt = `${head}\n…[skill "${name}" body trimmed: ${omitted} chars omitted, key guidance kept at head/tail]…\n${tail}`;
    }
    out.push(`## ${name}`);
    if (prompt) out.push(prompt);
    out.push('');
    inSkill = false;
    buffer = '';
  };

  for (const ln of lines) {
    if (/^## /.test(ln)) {
      flush();
      inSkill = true;
      buffer = ln;
    } else if (inSkill) {
      buffer += '\n' + ln;
    } else {
      out.push(ln);
    }
  }
  flush();

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Compact a batch of RAG chunks: drop near-duplicate entries (same
 * source/title prefix) and cap each chunk's length. Keeps retrieval quality
 * intact while shedding the redundant bulk.
 */
export function compactRagChunks(chunks: string[], perChunk: number = RAG_CHUNK_MAX): string[] {
  if (!chunks.length) return chunks;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chunks) {
    const sep = c.indexOf(': ');
    const key = c.slice(0, sep > 0 ? sep : 40); // [source] title — dedupe on source+title
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.length > perChunk ? c.slice(0, perChunk) + '…' : c);
  }
  return out;
}

export interface CompressReport {
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  savedPct: number;
  changed: boolean;
}

export function reportFor(before: string, after: string): CompressReport {
  const bt = estTokens(before);
  const at = estTokens(after);
  const saved = Math.max(0, bt - at);
  return {
    beforeChars: before.length,
    afterChars: after.length,
    beforeTokens: bt,
    afterTokens: at,
    savedTokens: saved,
    savedPct: bt ? Math.round((saved / bt) * 100) : 0,
    changed: after.length < before.length,
  };
}
