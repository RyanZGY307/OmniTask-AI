"""adb-orchestrator: 多设备 ADB 测试编排工具。

模块边界：
- device   单设备封装（lazy 属性 + 类型化异常 + 超时杀进程组）
- parser   logcat/dumpsys 解析（增量、多行、跨 buffer）
- runner   并发调度 + 指数退避重试 + 进度回调
- report   JSON/HTML 报告
- cli      argparse 入口（list/install/run/report）
"""

__version__ = "0.1.0"

from .device import AdbDevice, CmdResult, DeviceState
from .parser import LogcatParser, LogRecord
from .runner import Runner, TaskResult

__all__ = [
    "AdbDevice",
    "CmdResult",
    "DeviceState",
    "LogcatParser",
    "LogRecord",
    "Runner",
    "TaskResult",
    "__version__",
]
