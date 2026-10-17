"""报告输出（F5）：report.json（含 schema_version）与 report.html。"""

import html
import json
import logging
from dataclasses import asdict
from typing import List

from .runner import TaskResult

log = logging.getLogger("orchestrator.report")

SCHEMA_VERSION = "1.0"


def write_json(results: List[TaskResult], out_path: str,
               schema_version: str = SCHEMA_VERSION) -> None:
    payload = {
        "schema_version": schema_version,
        "total": len(results),
        "success": sum(1 for r in results if r.success),
        "results": [asdict(r) for r in results],
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log.info("已写出 %s", out_path)


def write_html(results: List[TaskResult], out_path: str) -> None:
    rows = []
    for r in results:
        badge = "ok" if r.success else "fail"
        extra = f" (retried x{r.attempts})" if r.retried else ""
        body = html.escape(r.output or r.error)
        rows.append(
            f"<tr class='{badge}'>"
            f"<td>{html.escape(r.serial)}</td>"
            f"<td class='st-{badge}'>{'SUCCESS' if r.success else 'FAIL'}{extra}</td>"
            f"<td>{html.escape(str(r.duration))}s</td>"
            f"<td class='body'>{body}</td></tr>"
        )
    ok = sum(1 for r in results if r.success)
    page = f"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>adb-orchestrator report</title>
<style>
 body{{font-family:system-ui,sans-serif;margin:24px;color:#111}}
 table{{border-collapse:collapse;width:100%}}
 th,td{{border:1px solid #ccc;padding:6px 10px;text-align:left;vertical-align:top}}
 th{{background:#f5f5f5}}
 .st-ok{{color:#0a7d33;font-weight:600}} .st-fail{{color:#c0392b;font-weight:600}}
 .body{{white-space:pre-wrap;max-width:40em}}
</style></head><body>
<h1>adb-orchestrator 报告</h1>
<p>共 {len(results)} 台设备，成功 {ok}，失败 {len(results)-ok}。</p>
<table><thead><tr><th>serial</th><th>状态</th><th>耗时</th><th>输出/错误</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table>
</body></html>
"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(page)
    log.info("已写出 %s", out_path)
