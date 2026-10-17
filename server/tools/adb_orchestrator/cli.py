"""命令行入口（F5）。子命令 list / install / run / report。

退出码规范：0 成功 / 1 部分失败 / 2 全部失败 / 3 参数错误。
"""

import argparse
import logging
import sys
from typing import List, Optional

from .device import AdbDevice
from .report import write_html, write_json
from .runner import Runner, TaskResult
from .utils.errors import AdbError

EXIT_OK = 0
EXIT_PARTIAL = 1
EXIT_ALL = 2
EXIT_ARGS = 3


class _CliParser(argparse.ArgumentParser):
    """让参数错误以受控异常上抛，映射到退出码 3（而非 argparse 默认的 2）。"""

    def error(self, message):  # noqa: ANN001 - argparse 钩子签名固定
        raise _ArgumentError(message)


class _ArgumentError(Exception):
    pass


def _exit_code(results: List[TaskResult]) -> int:
    if not results:
        return EXIT_ALL
    ok = sum(1 for r in results if r.success)
    if ok == len(results):
        return EXIT_OK
    if ok == 0:
        return EXIT_ALL
    return EXIT_PARTIAL


def _progress(done: int, total: int, r: TaskResult) -> None:
    mark = "+" if r.success else "x"
    print(f"[{mark}] {r.serial} ({done}/{total})"
          + (f" -> {r.error}" if r.error else ""), file=sys.stderr)


def _select_devices(args) -> List[AdbDevice]:
    """按 --devices 过滤；未指定则取全部 state==device 的设备。"""
    devices = AdbDevice.list_devices(adb_bin=getattr(args, "adb", "adb"))
    if getattr(args, "devices", None):
        wanted = set(args.devices)
        picked = [d for d in devices if d.serial in wanted]
        missing = wanted - {d.serial for d in picked}
        if missing:
            print(f"警告：以下序列号未在线: {sorted(missing)}", file=sys.stderr)
        return picked
    return [d for d in devices if d.state == "device"]


def _cmd_list(args) -> int:
    devices = _select_devices(args)
    if not devices:
        print("无可用设备", file=sys.stderr)
        return EXIT_ALL
    print(f"{'serial':<24} {'state':<12} {'model':<16} {'sdk':<5} {'abi':<16} battery")
    for d in devices:
        print(f"{d.serial:<24} {d.state:<12} {d.model:<16} "
              f"{d.sdk:<5} {d.abi:<16} {d.battery}")
    return EXIT_OK


def _cmd_install(args) -> int:
    devices = _select_devices(args)
    if not devices:
        print("无可用设备可安装", file=sys.stderr)
        return EXIT_ALL
    runner = Runner(max_workers=args.workers,
                    max_retries=args.retries, base_delay=args.base_delay)
    apks = args.apk

    def task(d: AdbDevice) -> str:
        out = ""
        for apk in apks:
            res = d.run(["install", "-r", apk], timeout=args.timeout)
            out += f"{apk}: {res.stdout}\n"
        return out.strip()

    results = runner.run_tasks([(d, task) for d in devices], progress=_progress)
    _write_reports(args, results)
    return _exit_code(results)


def _cmd_run(args) -> int:
    devices = _select_devices(args)
    if not devices:
        print("无可用设备可执行", file=sys.stderr)
        return EXIT_ALL
    runner = Runner(max_workers=args.workers,
                    max_retries=args.retries, base_delay=args.base_delay)

    def task(d: AdbDevice) -> str:
        res = d.run(["shell"] + list(args.command), timeout=args.timeout)
        return res.stdout

    results = runner.run_tasks([(d, task) for d in devices], progress=_progress)
    _write_reports(args, results)
    return _exit_code(results)


def _cmd_report(args) -> int:
    results = _load_results(args.input)
    out = args.output
    if not out.lower().endswith(".html"):
        write_json(results, out)
    else:
        write_html(results, out)
    print(f"报告已写入 {out}", file=sys.stderr)
    return EXIT_OK


def _load_results(path: str) -> List[TaskResult]:
    import json
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    out = []
    for item in data.get("results", []):
        out.append(TaskResult(
            serial=item.get("serial", "?"),
            success=bool(item.get("success")),
            output=item.get("output", ""),
            error=item.get("error", ""),
            attempts=int(item.get("attempts", 1)),
            duration=float(item.get("duration", 0.0)),
            retried=bool(item.get("retried", False)),
        ))
    return out


def _write_reports(args, results: List[TaskResult]) -> None:
    base = getattr(args, "report", "report")
    write_json(results, base + ".json")
    write_html(results, base + ".html")


def build_parser() -> _CliParser:
    p = _CliParser(prog="adb-orchestrator", description="多设备 ADB 测试编排工具")
    p.add_argument("-v", "--verbose", action="store_true", help="开启 DEBUG 日志")
    sub = p.add_subparsers(dest="cmd", required=True)

    def _common(sp, need_apk: bool):
        sp.add_argument("--devices", "-d", action="append",
                        help="指定序列号（可多次）；缺省取全部 device 态设备")
        sp.add_argument("--workers", type=int, default=8)
        sp.add_argument("--retries", type=int, default=2)
        sp.add_argument("--base-delay", type=float, default=1.0)
        sp.add_argument("--timeout", type=int, default=30)
        sp.add_argument("--report", default="report", help="报告输出前缀（不带扩展名）")
        sp.add_argument("--adb", default="adb", help="adb 可执行文件路径")
        if need_apk:
            sp.add_argument("apk", nargs="+", help="APK 路径")

    sp_list = sub.add_parser("list", help="列出设备与状态")
    _common(sp_list, need_apk=False)

    sp_install = sub.add_parser("install", help="批量安装 APK")
    _common(sp_install, need_apk=True)

    sp_run = sub.add_parser("run", help="在设备执行 shell 命令")
    _common(sp_run, need_apk=False)
    sp_run.add_argument("command", nargs="+", help="shell 命令（多参数拆分传入）")

    sp_report = sub.add_parser("report", help="由 report.json 重新生成 HTML")
    sp_report.add_argument("--input", default="report.json", help="输入 json")
    sp_report.add_argument("--output", default="report.html", help="输出 html")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    logging.basicConfig(
        level=logging.DEBUG if argv and "-v" in argv else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        if getattr(args, "verbose", False):
            logging.getLogger("orchestrator").setLevel(logging.DEBUG)
    except _ArgumentError as exc:
        print(f"参数错误: {exc}", file=sys.stderr)
        return EXIT_ARGS

    handlers = {
        "list": _cmd_list,
        "install": _cmd_install,
        "run": _cmd_run,
        "report": _cmd_report,
    }
    try:
        return handlers[args.cmd](args)
    except AdbError as exc:
        print(f"adb 错误: {exc}", file=sys.stderr)
        return EXIT_ALL
    except _ArgumentError:
        return EXIT_ARGS


if __name__ == "__main__":
    sys.exit(main())
