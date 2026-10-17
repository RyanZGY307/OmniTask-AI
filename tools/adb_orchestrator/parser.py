"""logcat / dumpsys 解析。

- F3：LogcatParser.feed(line) 增量解析 threadtime 格式；
      处理多行堆栈（无前缀的续行并入上一条 msg）与跨 buffer 混合（buffer 头行切换）。
- LogRecord 携带 buffer 字段，便于按 buffer 归因。
- find_anr()/find_crash()/find_watchdog() 基于已累积 records 做规则匹配。
"""

import re
from dataclasses import dataclass
from typing import List, Optional

# threadtime:  "MM-DD hh:mm:ss.mmm  pid  tid  L/TAG:  msg"
# 注意 L 与 TAG 之间是斜杠（如 "E/AndroidRuntime"），而非空格。
_THREADTIME_RE = re.compile(
    r"^\s*(?P<date>\d{2}-\d{2})\s+(?P<time>\d{2}:\d{2}:\d{2}\.\d{3})\s+"
    r"(?P<pid>\d+)\s+(?P<tid>\d+)\s+"
    r"(?P<level>[VDIWEF])/(?P<tag>[^:]*):?\s*(?P<msg>.*$)"
)

# 合法 buffer 名（旧/新 logcat 头行的缓冲名）。
_KNOWN_BUFFERS = {"main", "system", "crash", "events", "radio", "kernel",
                 "default", "stats", "all"}
_BEGINNING_RE = re.compile(r"beginning of (\w+)", re.I)
_OLDR_HEAD_RE = re.compile(r"^-{2,}\s*(\w+)")


@dataclass
class LogRecord:
    ts: str
    pid: int
    tid: int
    level: str
    tag: str
    msg: str
    buffer: str = "main"


class LogcatParser:
    """增量 logcat 解析器。feed() 喂原始行；records 累积全部已闭合记录。"""

    def __init__(self) -> None:
        self.records: List[LogRecord] = []
        self._pending: Optional[LogRecord] = None
        self._cur_buffer: str = "main"

    # ---------- 增量入口 ----------
    def feed(self, line: str) -> Optional[LogRecord]:
        """喂入一行；返回：
        - 新的 threadtime 记录对象（本行是记录起点）
        - None（本行是续行 / buffer 头 / 无主行）
        续行会被并入上一条记录 msg，因此多行堆栈得以保留。
        """
        line = line.rstrip("\n")

        buf = self._buffer_marker(line)
        if buf:
            self._cur_buffer = buf
            return None

        m = _THREADTIME_RE.match(line)
        if m:
            rec = LogRecord(
                ts=m.group("date") + " " + m.group("time"),
                pid=int(m.group("pid")),
                tid=int(m.group("tid")),
                level=m.group("level"),
                tag=m.group("tag").strip(),
                msg=m.group("msg"),
                buffer=self._cur_buffer,
            )
            self.records.append(rec)
            self._pending = rec
            return rec

        # 无 threadtime 前缀：若已有 pending，则视为续行并入；否则丢弃（孤儿行）。
        if self._pending is not None:
            self._pending.msg = self._pending.msg + "\n" + line
        return None

    def _buffer_marker(self, line: str) -> Optional[str]:
        s = line.strip()
        if not s.startswith("-"):
            return None
        mb = _BEGINNING_RE.search(s)
        if mb:
            return mb.group(1).lower()
        mo = _OLDR_HEAD_RE.match(s)
        if mo and mo.group(1) in _KNOWN_BUFFERS:
            return mo.group(1).lower()
        return None

    # ---------- 规则检索 ----------
    def find_anr(self) -> List[LogRecord]:
        out = []
        for r in self.records:
            if "ANR in" in r.msg or (r.tag == "ActivityManager" and "ANR" in r.msg):
                out.append(r)
        return out

    def find_crash(self) -> List[LogRecord]:
        out = []
        for r in self.records:
            hit = (
                r.level == "F"
                or "FATAL EXCEPTION" in r.msg
                or "Fatal signal" in r.msg
                or r.tag in ("AndroidRuntime", "libc", "DEBUG", "crash")
            )
            if hit:
                out.append(r)
        return out

    def find_watchdog(self) -> List[LogRecord]:
        out = []
        for r in self.records:
            up = r.msg.upper()
            if (
                r.tag in ("Watchdog", "WATCHDOG")
                or "WATCHDOG" in up
                or "held for more than 3000ms" in r.msg
            ):
                out.append(r)
        return out
