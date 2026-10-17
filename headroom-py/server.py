#!/usr/bin/env python
# ================================================================
# Headroom-equivalent context compressor — pure-Python stdio MCP server.
#
# This is NOT the headroom-ai Rust package (that cannot build in a musl
# sandbox without a C toolchain). It re-implements headroom's core value:
# compress the tool outputs / logs / JSON / text that get fed to the LLM so
# they cost fewer tokens, keep a reversible CCR store (retrieve the original
# on demand), and report stats. No Rust, no ONNX — only stdlib + the `mcp`
# and `pydantic` libs already installed in the venv.
#
# Tools:
#   headroom_compress(content, kind?) -> compressed + savings + CCR handle
#   headroom_retrieve(handle)         -> the original, lossless
#   headroom_stats()                  -> cumulative compression accounting
#
# Run:  <venv-python> server.py            (stdio MCP)
#       <venv-python> server.py --selftest (logic check, no MCP)
# ================================================================

import os
import sys
import json
import uuid
import time
import re

STATE_DIR = os.environ.get("HEADROOM_PY_STATE_DIR", os.path.expanduser("~/.headroom-py"))
CCR_DIR = os.path.join(STATE_DIR, "ccr")
STATS_FILE = os.path.join(STATE_DIR, "stats.json")

TEXT_COMPRESS_THRESHOLD = 4000   # chars; shorter text is left as-is
KEEP_HEAD_LINES = 20
KEEP_TAIL_LINES = 30
LOG_NOISE_RE = re.compile(
    r"(ERROR|WARN(?:ING)?|FATAL|EXCEPTION|Traceback|panic|CRITICAL|failed|5\d\d\b|status.?:?\s*[45]\d\d)",
    re.IGNORECASE,
)


# ----------------------------------------------------------------
# CCR (Compress-Cache-Retrieve) — lossless original store
# ----------------------------------------------------------------

def _ensure_state():
    os.makedirs(CCR_DIR, exist_ok=True)


def ccr_store(handle_id, payload, meta):
    _ensure_state()
    with open(os.path.join(CCR_DIR, handle_id + ".json"), "w") as f:
        json.dump({"handle": handle_id, "meta": meta, "raw": payload}, f)
    return handle_id


def ccr_retrieve(handle_id):
    path = os.path.join(CCR_DIR, handle_id + ".json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def est_tokens(text):
    # Rough char/3 estimate (matches the app's own heuristic); good enough
    # to show relative savings without pulling in a full tokenizer.
    return max(1, len(text) // 3)


# ----------------------------------------------------------------
# Compressors
# ----------------------------------------------------------------

def detect_kind(content):
    if content is None:
        return "text", None
    if isinstance(content, (list, dict)):
        return "json", None
    s = str(content).strip()
    try:
        json.loads(s)
        return "json", None
    except Exception:
        pass
    lines = s.splitlines()
    noise = sum(1 for l in lines if LOG_NOISE_RE.search(l))
    if len(lines) >= 4 and noise >= min(2, len(lines) // 4):
        return "log", None
    return "text", None


def _as_json_value(content):
    if isinstance(content, (list, dict)):
        return content
    try:
        return json.loads(content)
    except Exception:
        return None


def compress_json_list(items, keep_head=5, keep_tail=5):
    total = len(items)
    # Order-preserving dedup with duplicate counts
    seen = {}
    dupes = {}
    unique = []
    for it in items:
        key = json.dumps(it, sort_keys=True, ensure_ascii=False, default=str)
        if key in seen:
            dupes[key] = dupes.get(key, 1) + 1
            continue
        seen[key] = True
        unique.append(it)
    kept = []
    seen_keys = set()
    for it in unique[:keep_head] + unique[-keep_tail:]:
        key = json.dumps(it, sort_keys=True, ensure_ascii=False, default=str)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        kept.append(it)
    # Always surface anomaly / error items even if not in head/tail
    for it in unique:
        key = json.dumps(it, sort_keys=True, ensure_ascii=False, default=str)
        if key in seen_keys:
            continue
        s = json.dumps(it, ensure_ascii=False)
        if LOG_NOISE_RE.search(s) or "error" in s.lower() or '"ok": false' in s.lower().replace(" ", ""):
            kept.append(it)
            seen_keys.add(key)
    dupes_slim = {}
    for k, c in dupes.items():
        val = json.loads(k)
        dupes_slim[str(val)[:80]] = c
    result = {
        "_headroom": {
            "kind": "json-list",
            "total": total,
            "unique": len(unique),
            "kept": len(kept),
            "dups_folded": len(dupes),
            "note": "duplicates folded; head/tail + anomaly rows kept; original retrievable via handle",
        },
        "items": kept,
    }
    if dupes_slim:
        result["duplicate_counts"] = dict(list(dupes_slim.items())[:20])
    return result, total


def compress_json_dict(obj):
    summary = {}
    out = {}
    folded = 0
    for k, v in obj.items():
        if isinstance(v, list) and len(v) > 8:
            comp, _ = compress_json_list(v)
            out[k] = comp
            folded += len(v)
        else:
            out[k] = v
        if isinstance(v, (str,)) and len(v) > 500:
            summary[k] = f"<long string {len(v)} chars>"
    result = {
        "_headroom": {"kind": "json-dict", "keys": len(obj), "folded_lists": folded, "note": "large sub-lists compressed"},
        "data": out,
    }
    return result, sum(len(json.dumps(v)) for v in out.values())


def compress_log(text):
    lines = text.splitlines()
    total = len(lines)
    head = lines[:KEEP_HEAD_LINES]
    tail = lines[-KEEP_TAIL_LINES:]
    middle = lines[KEEP_HEAD_LINES:-KEEP_TAIL_LINES] if total > KEEP_HEAD_LINES + KEEP_TAIL_LINES else []

    # Collapse consecutive identical lines in the middle
    collapsed = []
    dup_runs = 0
    i = 0
    while i < len(middle):
        line = middle[i]
        j = i
        while j < len(middle) and middle[j] == line:
            j += 1
        run = j - i
        if run > 1:
            collapsed.append(f"{line}  # x{run}")
            dup_runs += run - 1
        else:
            collapsed.append(line)
        i = j

    # Keep middle lines that look like errors/warnings
    important = [l for l in collapsed if LOG_NOISE_RE.search(l)]
    kept = head + important + (tail if tail else [])

    omitted = total - len(head) - len(tail) - len(important)
    note = "consecutive repeats folded; error/warn lines kept; head/tail preserved"
    result_lines = [
        f"[headroom:log total_lines={total} unique_folded={dup_runs} omitted_middle≈{omitted}]",
        *head,
    ]
    if important:
        result_lines.append("[...omitted, kept anomalies...]")
        result_lines.extend(important)
    if tail and not (tail == head and total <= KEEP_HEAD_LINES + KEEP_TAIL_LINES):
        result_lines.append("[...tail...]")
        result_lines.extend(tail)
    return "\n".join(result_lines), total


def _head_tail_by_char(text, budget=1500):
    lines = text.splitlines()
    if len(lines) <= 1:
        return text[:budget], text[-budget:]
    head, hb = [], 0
    for l in lines:
        if hb + len(l) + 1 > budget:
            break
        head.append(l)
        hb += len(l) + 1
    tail, tb = [], 0
    for l in reversed(lines):
        if tb + len(l) + 1 > budget:
            break
        tail.insert(0, l)
        tb += len(l) + 1
    return "\n".join(head), "\n".join(tail)


def compress_text(text):
    lines = text.splitlines()
    if len(text) <= TEXT_COMPRESS_THRESHOLD:
        return text, 0, "short text left as-is"
    head, tail = _head_tail_by_char(text)
    mid_chars = len(text) - len(head) - len(tail)
    out = (
        f"[headroom:text total_chars={len(text)} lines={len(lines)} — middle {mid_chars} chars omitted]\n"
        f"{head}\n\n[...omitted...]\n\n{tail}"
    )
    return out, len(text), "middle omitted; head/tail kept by char budget"


# ----------------------------------------------------------------
# Public tool functions (also used by --selftest)
# ----------------------------------------------------------------

def tool_compress(content, kind=None):
    text_repr = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, default=str)
    detected, _ = detect_kind(content)
    k = (kind or detected or "text").lower()
    before_tokens = est_tokens(text_repr)

    handle = uuid.uuid4().hex[:16]
    note = ""
    if k == "json":
        val = _as_json_value(content)
        if val is not None:
            if isinstance(val, list):
                out_obj, _ = compress_json_list(val)
                compressed = json.dumps(out_obj, ensure_ascii=False)
                ccr_store(handle, text_repr, {"kind": "json"})
            elif isinstance(val, dict):
                out_obj, _ = compress_json_dict(val)
                compressed = json.dumps(out_obj, ensure_ascii=False)
                ccr_store(handle, text_repr, {"kind": "json"})
            else:
                compressed, _omitted, note = compress_text(text_repr)
        else:
            compressed, _omitted, note = compress_text(text_repr)
    elif k == "log":
        compressed, _tot = compress_log(text_repr)
        ccr_store(handle, text_repr, {"kind": "log"})
        note = "lossless CCR handle attached"
    else:
        compressed, _omitted, note = compress_text(text_repr)
        ccr_store(handle, text_repr, {"kind": "text"})

    after_tokens = est_tokens(compressed)
    saved = max(0, before_tokens - after_tokens)
    ratio = (saved / before_tokens) if before_tokens else 0.0

    # stats
    _ensure_state()
    stats = {"count": 0, "tokens_saved": 0}
    if os.path.exists(STATS_FILE):
        try:
            with open(STATS_FILE) as f:
                stats = json.load(f)
        except Exception:
            pass
    stats["count"] = int(stats.get("count", 0)) + 1
    stats["tokens_saved"] = int(stats.get("tokens_saved", 0)) + saved
    stats["last_at"] = time.time()
    with open(STATS_FILE, "w") as f:
        json.dump(stats, f)

    return {
        "compressed": compressed,
        "kind": k,
        "handle": handle,
        "est_before_tokens": before_tokens,
        "est_after_tokens": after_tokens,
        "est_tokens_saved": saved,
        "saved_pct": round(ratio * 100, 1),
        "note": note or "ok",
        "retrieve_with": handle,
    }


def tool_retrieve(handle):
    rec = ccr_retrieve(handle)
    if not rec:
        return {"ok": False, "error": f"handle {handle} not found (CCR store: {CCR_DIR})"}
    return {"ok": True, "handle": handle, "kind": rec.get("meta", {}).get("kind"), "original": rec["raw"]}


def tool_stats():
    if not os.path.exists(STATS_FILE):
        return {"count": 0, "tokens_saved": 0, "ccr_dir": CCR_DIR}
    with open(STATS_FILE) as f:
        s = json.load(f)
    ccr_count = len(os.listdir(CCR_DIR)) if os.path.isdir(CCR_DIR) else 0
    s["ccr_stored"] = ccr_count
    s["ccr_dir"] = CCR_DIR
    return s


# ----------------------------------------------------------------
# Self-test (no MCP protocol)
# ----------------------------------------------------------------

def selftest():
    # 1) JSON list with duplicates
    data = json.dumps({"results": [
        {"id": i % 7, "status": "ok" if i % 5 else "error", "payload": "x" * 200, "score": i}
        for i in range(120)
    ]})
    r = tool_compress(data, "json")
    print("JSON before≈", r["est_before_tokens"], "after≈", r["est_after_tokens"],
          "saved", r["est_tokens_saved"], f"({r['saved_pct']}%)")

    big = json.dumps(r["compressed"])
    rec = tool_retrieve(r["handle"])
    assert rec["ok"] and rec["original"] == data, "CCR retrieve mismatch"
    print("CCR retrieve round-trip OK, chars:", len(rec["original"]))

    # 2) Log with repeated lines + errors
    log = "\n".join(
        ["GET /api/items 200"] * 60
        + ["ERROR db timeout after 30s"]
        + ["GET /api/items 200"] * 60
        + ["WARN cache miss"]
    )
    lr = tool_compress(log, "log")
    print("LOG lines", len(log.splitlines()), "->", len(lr["compressed"].splitlines()),
          "saved", lr["est_tokens_saved"])

    # 3) Long text
    text = ("Some analysis prose. " * 400)
    tr = tool_compress(text, "text")
    print("TEXT chars", len(text), "->", len(tr["compressed"]), "saved", tr["est_tokens_saved"])

    print("STATS:", json.dumps(tool_stats()))
    print("\nSELFTEST PASSED")


# ----------------------------------------------------------------
# MCP server (stdio)
# ----------------------------------------------------------------

def build_mcpserver():
    from mcp.server.mcpserver import MCPServer

    mcp = MCPServer("headroom")

    @mcp.tool()
    def headroom_compress(content: str, kind: str = "auto") -> dict:
        """Compress tool output / log / JSON / text to fewer tokens.

        Returns the compressed payload, an estimated token saving, and a CCR
        handle to retrieve the original losslessly. kind: auto|json|log|text."""
        return tool_compress(content, kind)

    @mcp.tool()
    def headroom_retrieve(handle: str) -> dict:
        """Retrieve the original, un-compressed content for a CCR handle returned by headroom_compress."""
        return tool_retrieve(handle)

    @mcp.tool()
    def headroom_stats() -> dict:
        """Cumulative compression accounting (count, estimated tokens saved, CCR store size)."""
        return tool_stats()

    return mcp


def amain():
    mcp = build_mcpserver()
    mcp.run(transport="stdio")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        amain()
